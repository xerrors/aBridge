package main

import (
	"context"
	"testing"
	"time"
)

type gatedRunner struct {
	started chan string
	release map[string]chan struct{}
}

func (r gatedRunner) Run(ctx context.Context, id, _, _ string, step func(string, string)) (string, error) {
	r.started <- id
	select {
	case <-r.release[id]:
		step("computer_act", "executed")
		return "verified", nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func TestDevicesRunInParallelAndTasksForOneDeviceStayOrdered(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	runner := gatedRunner{started: make(chan string, 3), release: map[string]chan struct{}{"A1": make(chan struct{}), "A2": make(chan struct{}), "B1": make(chan struct{})}}
	s := newScheduler(ctx, runner, 2)
	t.Cleanup(func() { cancel(); s.wait() })
	take := func(want string) {
		t.Helper()
		select {
		case got := <-runner.started:
			if got != want {
				t.Fatalf("started %s, want %s", got, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("did not start %s", want)
		}
	}
	s.submit("A1", "A", "one")
	take("A1")
	s.submit("A2", "A", "two")
	s.submit("B1", "B", "other")
	take("B1")
	if queued, _ := s.get("A2"); queued.Status != "queued" {
		t.Fatalf("A2 status: %s", queued.Status)
	}
	close(runner.release["A1"])
	take("A2")
	if first, _ := s.get("A1"); first.Status != "completed" || len(first.Steps) != 1 {
		t.Fatalf("A1 result: %+v", first)
	}
	close(runner.release["A2"])
	close(runner.release["B1"])
	s.wait()
}

type waitingRunner struct {
	waiting chan struct{}
	resume  chan struct{}
}

func (r waitingRunner) Run(ctx context.Context, _, _, _ string, onStep func(string, string)) (string, error) {
	onStep("device_wait", "waiting_for_unlock")
	close(r.waiting)
	select {
	case <-r.resume:
		onStep("device_wait", "running")
		onStep("computer_observe", "executed")
		return "verified", nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func TestWaitingTaskPublishesStateAndResumesWithoutFinishingEarly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	runner := waitingRunner{waiting: make(chan struct{}), resume: make(chan struct{})}
	s := newScheduler(ctx, runner, 1)
	t.Cleanup(func() { cancel(); s.wait() })
	s.submit("waiting", "device", "describe")
	select {
	case <-runner.waiting:
	case <-time.After(time.Second):
		t.Fatal("task did not enter waiting state")
	}
	waiting, _ := s.get("waiting")
	if waiting.Status != "waiting_for_unlock" || !waiting.Finished.IsZero() || waiting.Result != "" {
		t.Fatalf("waiting snapshot %+v", waiting)
	}
	close(runner.resume)
	s.wait()
	finished, _ := s.get("waiting")
	if finished.Status != "completed" || finished.Finished.IsZero() || finished.Result != "verified" || len(finished.Steps) != 3 {
		t.Fatalf("finished snapshot %+v", finished)
	}
}

type cancellableRunner struct {
	started  chan string
	stopping chan struct{}
	release  chan struct{}
}

func (r cancellableRunner) Run(ctx context.Context, id, _, _ string, onStep func(string, string)) (string, error) {
	r.started <- id
	if id != "first" {
		return "verified", nil
	}
	onStep("device_wait", "waiting_for_unlock")
	<-ctx.Done()
	close(r.stopping)
	onStep("device_wait", "running")
	onStep("computer_act", "outcome_unknown")
	<-r.release
	return "", ctx.Err()
}

func TestCancelQueuedAndWaitingTasksKeepsDeviceOccupiedUntilCleanup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	runner := cancellableRunner{started: make(chan string, 3), stopping: make(chan struct{}), release: make(chan struct{})}
	s := newScheduler(ctx, runner, 1)
	t.Cleanup(func() { cancel(); s.wait() })
	s.submit("first", "device", "one")
	if id := <-runner.started; id != "first" {
		t.Fatal(id)
	}
	s.submit("second", "device", "two")
	s.submit("third", "device", "three")
	queued, ok := s.cancelTask("third")
	if !ok || queued.Status != "cancelled" || queued.Finished.IsZero() || queued.prompt != "" {
		t.Fatalf("queued cancellation %+v, ok %v", queued, ok)
	}
	cancelling, ok := s.cancelTask("first")
	if !ok || cancelling.Status != "cancelling" || !cancelling.Finished.IsZero() {
		t.Fatalf("active cancellation %+v, ok %v", cancelling, ok)
	}
	select {
	case <-runner.stopping:
	case <-time.After(time.Second):
		t.Fatal("runner did not receive cancellation")
	}
	if current, _ := s.get("first"); current.Status != "cancelling" {
		t.Fatalf("late wait state replaced cancelling: %+v", current)
	}
	select {
	case next := <-runner.started:
		t.Fatalf("next task %s started before cleanup", next)
	default:
	}
	close(runner.release)
	s.wait()
	if next := <-runner.started; next != "second" {
		t.Fatalf("next task %q", next)
	}
	first, _ := s.get("first")
	if first.Status != "cancelled" || first.Finished.IsZero() {
		t.Fatalf("final cancellation %+v", first)
	}
	if first.Steps[len(first.Steps)-1].Status != "outcome_unknown" {
		t.Fatalf("unknown operation receipt was lost: %v", first.Steps)
	}
	second, _ := s.get("second")
	unchanged, ok := s.cancelTask("second")
	if !ok || unchanged.Status != "completed" || unchanged.Result != second.Result || unchanged.Finished != second.Finished {
		t.Fatalf("completed task changed: before %+v after %+v", second, unchanged)
	}
	if _, ok := s.cancelTask("missing"); ok {
		t.Fatal("missing task cancellation succeeded")
	}
}
