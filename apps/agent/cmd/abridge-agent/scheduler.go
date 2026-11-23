package main

import (
	"context"
	"maps"
	"slices"
	"sync"
	"time"
)

type task struct {
	ID              string    `json:"id"`
	Device          string    `json:"device_id"`
	Status          string    `json:"status"`
	Steps           []step    `json:"steps"`
	Result          string    `json:"result,omitempty"`
	Error           string    `json:"error,omitempty"`
	Created         time.Time `json:"created_at"`
	Finished        time.Time `json:"-"`
	prompt          string
	cancel          context.CancelFunc
	cancelRequested bool
}

type step struct {
	Tool   string `json:"tool"`
	Status string `json:"status"`
}

type taskRunner interface {
	Run(context.Context, string, string, string, func(string, string)) (string, error)
}

type scheduler struct {
	ctx         context.Context
	runner      taskRunner
	parallelism int
	mu          sync.Mutex
	workers     sync.WaitGroup
	tasks       map[string]*task
	pending     []*task
	active      map[string]bool
}

func newScheduler(ctx context.Context, runner taskRunner, parallelism int) *scheduler {
	return &scheduler{ctx: ctx, runner: runner, parallelism: parallelism, tasks: make(map[string]*task), active: make(map[string]bool)}
}

func (s *scheduler) submit(id, device, prompt string) (task, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	maps.DeleteFunc(s.tasks, func(_ string, t *task) bool {
		return !t.Finished.IsZero() && time.Since(t.Finished) > time.Hour
	})
	if len(s.tasks) >= 256 {
		var oldest *task
		for _, task := range s.tasks {
			if !task.Finished.IsZero() && (oldest == nil || task.Finished.Before(oldest.Finished)) {
				oldest = task
			}
		}
		if oldest != nil {
			delete(s.tasks, oldest.ID)
		}
	}
	if s.ctx.Err() != nil || len(s.pending) >= 32 || len(s.tasks) >= 256 {
		return task{}, false
	}
	t := &task{ID: id, Device: device, prompt: prompt, Status: "queued", Created: time.Now(), Steps: []step{}}
	s.tasks[id] = t
	s.pending = append(s.pending, t)
	s.dispatch()
	return *t, true
}

func (s *scheduler) get(id string) (task, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tasks[id]
	if !ok {
		return task{}, false
	}
	snapshot := *t
	snapshot.Steps = slices.Clone(t.Steps)
	return snapshot, true
}

func (s *scheduler) cancelTask(id string) (task, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tasks[id]
	if !ok {
		return task{}, false
	}
	if t.Finished.IsZero() && !t.cancelRequested {
		t.cancelRequested = true
		if t.Status == "queued" {
			s.pending = slices.DeleteFunc(s.pending, func(pending *task) bool { return pending.ID == id })
			t.Status = "cancelled"
			t.prompt = ""
			t.Finished = time.Now()
		} else {
			t.Status = "cancelling"
			if t.cancel != nil {
				t.cancel()
			}
		}
	}
	snapshot := *t
	snapshot.Steps = slices.Clone(t.Steps)
	return snapshot, true
}

// The caller holds mu. Select the first eligible task so a busy device does not delay other devices.
func (s *scheduler) dispatch() {
	for len(s.active) < s.parallelism && s.ctx.Err() == nil {
		i := slices.IndexFunc(s.pending, func(t *task) bool { return !s.active[t.Device] })
		if i < 0 {
			return
		}
		t := s.pending[i]
		s.pending = slices.Delete(s.pending, i, i+1)
		s.active[t.Device] = true
		t.Status = "running"
		s.workers.Add(1)
		go s.run(t)
	}
}

func (s *scheduler) run(t *task) {
	defer s.workers.Done()
	ctx, cancel := context.WithTimeout(s.ctx, 3*time.Minute)
	defer cancel()
	s.mu.Lock()
	t.cancel = cancel
	if t.cancelRequested {
		cancel()
	}
	s.mu.Unlock()
	value, err := s.runner.Run(ctx, t.ID, t.Device, t.prompt, func(tool, status string) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if tool == "device_wait" && !t.cancelRequested {
			switch status {
			case "waiting_for_device", "waiting_for_unlock", "waiting_for_screen", "running":
				t.Status = status
			}
		}
		t.Steps = append(t.Steps, step{Tool: tool, Status: status})
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	t.prompt = ""
	t.Finished = time.Now()
	t.cancel = nil
	if t.cancelRequested {
		t.Status = "cancelled"
	} else if err != nil {
		t.Status = "failed"
		t.Error = err.Error()
	} else {
		t.Status = "completed"
		t.Result = value
	}
	delete(s.active, t.Device)
	s.dispatch()
}

func (s *scheduler) wait() { s.workers.Wait() }
