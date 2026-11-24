package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/xerrors/aBridge/apps/agent/internal/agent"
	"github.com/xerrors/aBridge/apps/agent/internal/mcp"
	"github.com/xerrors/aBridge/apps/agent/internal/model"
)

func required(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}

func endpoint(name, value string) string {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.Fragment != "" || u.RawQuery != "" {
		log.Fatalf("%s must be an HTTP(S) service URL", name)
	}
	return value
}

const (
	deepSeekURL   = "https://api.deepseek.com"
	deepSeekModel = "deepseek-flash"
)

func modelSettings(getenv func(string) string) (string, string, string, error) {
	address := getenv("ABRIDGE_MODEL_URL")
	if address == "" {
		address = deepSeekURL
	}
	address = endpoint("ABRIDGE_MODEL_URL", address)
	parsed, _ := url.Parse(address)
	official := parsed.Scheme == "https" && strings.EqualFold(parsed.Hostname(), "api.deepseek.com") &&
		(parsed.Port() == "" || parsed.Port() == "443")
	name := getenv("ABRIDGE_MODEL")
	key := getenv("ABRIDGE_MODEL_KEY")
	if official {
		if name == "" {
			name = deepSeekModel
		}
		if key == "" {
			key = getenv("DEEPSEEK_API_KEY")
		}
		if key == "" {
			return "", "", "", errors.New("set DEEPSEEK_API_KEY (or ABRIDGE_MODEL_KEY) for the DeepSeek API")
		}
	} else if name == "" {
		return "", "", "", errors.New("set ABRIDGE_MODEL for the custom model endpoint")
	}
	return address, name, key, nil
}

func main() {
	requestKey := required("ABRIDGE_TASK_KEY")
	if len(requestKey) < 24 {
		log.Fatal("ABRIDGE_TASK_KEY must have at least 24 characters")
	}

	addr := os.Getenv("ABRIDGE_AGENT_LISTEN")
	if addr == "" {
		addr = "127.0.0.1:18821"
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("ABRIDGE_AGENT_LISTEN must use a loopback IP address and port")
	}

	parallelism := 2
	if value := os.Getenv("ABRIDGE_AGENT_PARALLELISM"); value != "" {
		parallelism, err = strconv.Atoi(value)
		if err != nil || parallelism < 1 || parallelism > 16 {
			log.Fatal("ABRIDGE_AGENT_PARALLELISM must be between 1 and 16")
		}
	}
	client := &http.Client{
		Timeout:       50 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	modelURL, modelName, modelKey, err := modelSettings(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	runner := agent.Runner{
		Bridge:  mcp.New(endpoint("ABRIDGE_MCP_URL", required("ABRIDGE_MCP_URL")), required("ABRIDGE_AGENT_KEY"), client),
		Planner: model.New(modelURL, modelKey, modelName, client),
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	queue := newScheduler(ctx, runner, parallelism)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		reply(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	withAuth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			key, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || subtle.ConstantTimeCompare([]byte(key), []byte(requestKey)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			next(w, r)
		}
	}
	mux.HandleFunc("POST /tasks", withAuth(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			DeviceID string `json:"device_id"`
			Prompt   string `json:"prompt"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || !atEnd(decoder) || !validID(input.DeviceID) || strings.TrimSpace(input.Prompt) == "" || len(input.Prompt) > 4096 {
			http.Error(w, "provide a device_id and a nonempty prompt up to 4096 bytes", http.StatusBadRequest)
			return
		}
		var id [16]byte
		if _, err := rand.Read(id[:]); err != nil {
			http.Error(w, "could not allocate task", http.StatusInternalServerError)
			return
		}
		t, ok := queue.submit(hex.EncodeToString(id[:]), input.DeviceID, strings.TrimSpace(input.Prompt))
		if !ok {
			http.Error(w, "task queue is full or shutting down", http.StatusServiceUnavailable)
			return
		}
		reply(w, http.StatusAccepted, t)
	}))
	mux.HandleFunc("GET /tasks/{id}", withAuth(func(w http.ResponseWriter, r *http.Request) {
		t, ok := queue.get(r.PathValue("id"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		reply(w, http.StatusOK, t)
	}))
	mux.HandleFunc("DELETE /tasks/{id}", withAuth(func(w http.ResponseWriter, r *http.Request) {
		t, ok := queue.cancelTask(r.PathValue("id"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		reply(w, http.StatusOK, t)
	}))
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("Agent listening at %s (parallelism %d)", addr, parallelism)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		stop()
		log.Fatalf("Agent server: %v", err)
	}
	queue.wait()
}

func atEnd(decoder *json.Decoder) bool {
	_, err := decoder.Token()
	return errors.Is(err, io.EOF)
}

func validID(value string) bool {
	if value == "" || len(value) > 100 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
