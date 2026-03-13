package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/elodin/tti-bench/internal/benchmark"
	"github.com/elodin/tti-bench/internal/web"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dataDir := flag.String("data", "./data", "data directory for persistent job storage")
	flag.Parse()

	store := benchmark.NewStore(benchmark.StoreConfig{DataDir: *dataDir})
	runner := benchmark.NewRunner(store)

	handler, err := web.NewHandler(store, runner)
	if err != nil {
		fmt.Fprintf(os.Stderr, "init handler: %v\n", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	handler.ServeHTTP(mux)

	srv := &http.Server{
		Addr:    *addr,
		Handler: mux,
	}

	go func() {
		log.Printf("Listening on http://localhost%s", *addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
