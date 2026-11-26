package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/xerrors/aBridge/apps/agent/internal/mcp"
)

func receiptPNG(t *testing.T, width, height int) mcp.Image {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: 220, G: 60, B: 20, A: 255})
		}
	}
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	return mcp.Image{Data: base64.StdEncoding.EncodeToString(data.Bytes()), MIMEType: "image/png"}
}

func TestTaskThumbnailDimensions(t *testing.T) {
	for _, size := range [][4]int{{1200, 600, 960, 480}, {600, 1200, 480, 960}, {64, 32, 64, 32}, {2000, 1, 960, 1}} {
		source := receiptPNG(t, size[0], size[1])
		url := taskThumbnail([]mcp.Image{source})
		const prefix = "data:image/jpeg;base64,"
		if !strings.HasPrefix(url, prefix) || len(url) > thumbnailMaxDataURL {
			t.Fatalf("invalid thumbnail URL length %d", len(url))
		}
		data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(url, prefix))
		if err != nil {
			t.Fatal(err)
		}
		img, err := jpeg.Decode(bytes.NewReader(data))
		if err != nil || img.Bounds().Dx() != size[2] || img.Bounds().Dy() != size[3] {
			t.Fatalf("thumbnail dimensions: %v, %v", img, err)
		}
		r, g, b, _ := img.At(0, 0).RGBA()
		if r <= g || g <= b {
			t.Fatal("thumbnail lost source colors")
		}
	}
}

func TestTaskThumbnailRejectsInvalidAndOversizedImages(t *testing.T) {
	source := receiptPNG(t, 2, 2)
	oversized := func(w, h uint32) mcp.Image {
		data, _ := base64.StdEncoding.DecodeString(source.Data)
		binary.BigEndian.PutUint32(data[16:20], w)
		binary.BigEndian.PutUint32(data[20:24], h)
		binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
		return mcp.Image{Data: base64.StdEncoding.EncodeToString(data), MIMEType: "image/png"}
	}
	for name, images := range map[string][]mcp.Image{
		"missing":         nil,
		"bad base64":      {{Data: "not base64!", MIMEType: "image/png"}},
		"bad pixels":      {{Data: base64.StdEncoding.EncodeToString([]byte("broken")), MIMEType: "image/png"}},
		"unsupported":     {{Data: source.Data, MIMEType: "image/webp"}},
		"input limit":     {{Data: strings.Repeat("A", base64.StdEncoding.EncodedLen(thumbnailMaxInputBytes)+1), MIMEType: "image/png"}},
		"dimension limit": {oversized(8193, 2)},
		"pixel limit":     {oversized(8192, 8192)},
	} {
		t.Run(name, func(t *testing.T) {
			if taskThumbnail(images) != "" {
				t.Fatal("invalid image produced a thumbnail")
			}
		})
	}
}

func TestTaskThumbnailAcceptsJPEGAndCompositesTransparency(t *testing.T) {
	var data bytes.Buffer
	if err := jpeg.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	if taskThumbnail([]mcp.Image{{MIMEType: "image/jpeg", Data: base64.StdEncoding.EncodeToString(data.Bytes())}}) == "" {
		t.Fatal("JPEG receipt missing")
	}
	data.Reset()
	if err := png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	url := taskThumbnail([]mcp.Image{{MIMEType: "image/png", Data: base64.StdEncoding.EncodeToString(data.Bytes())}})
	encoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(url, "data:image/jpeg;base64,"))
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	r, g, b, _ := img.At(0, 0).RGBA()
	if r < 65000 || g < 65000 || b < 65000 {
		t.Fatal("transparent pixels should have a white background")
	}
}

type receiptBridge struct{ result mcp.Result }

func (b receiptBridge) Tools(context.Context) ([]mcp.Tool, error) { return nil, nil }
func (b receiptBridge) Call(context.Context, string, map[string]json.RawMessage) (mcp.Result, error) {
	return b.result, nil
}

func TestReportingBridgeThumbnailPreservesModelResult(t *testing.T) {
	for _, valid := range []bool{true, false} {
		fixture := &workerFixture{}
		server := httptest.NewServer(http.HandlerFunc(fixture.serve))
		source := receiptPNG(t, 1200, 600)
		if !valid {
			source.Data = "broken"
		}
		original := mcp.Result{Text: json.RawMessage(`{"status":"executed"}`), Images: []mcp.Image{source}}
		reporter := &executionReporter{worker: &taskWorker{base: server.URL, key: "worker-secret", http: server.Client()}, task: workerTask{ID: "task-test", Lease: "lease"}, cancel: func() { t.Error("thumbnail cancelled task") }}
		bridge := reportingBridge{bridge: receiptBridge{original}, reporter: reporter}
		result, err := bridge.Call(context.Background(), "computer_observe", nil)
		server.Close()
		if err != nil || !reflect.DeepEqual(result, original) {
			t.Fatalf("model result changed: %v", err)
		}
		if len(fixture.events) != 2 || fixture.events[1]["status"] != "returned" || fixture.events[1]["receipt"] != `{"status":"executed"}` {
			t.Fatalf("missing receipt: %#v", fixture.events)
		}
		_, hasImage := fixture.events[1]["image"]
		if hasImage != valid {
			t.Fatalf("image attached = %v, want %v", hasImage, valid)
		}
		if _, ok := fixture.events[0]["image"]; ok {
			t.Fatal("started event contains an image")
		}
	}
}
