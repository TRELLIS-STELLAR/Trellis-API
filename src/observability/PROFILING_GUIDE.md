# Performance Profiling Guide for Trellis API

This guide explains how to use the built-in performance profiling tools to identify and resolve bottlenecks in the application.

## Overview

The observability module provides comprehensive profiling capabilities:
- CPU profiling (hot function identification)
- Memory profiling and heap snapshots
- Request waterfall timing analysis
- Performance baseline tracking and regression detection
- Memory leak detection

## Available Endpoints

### Profiling Endpoints (`/profiling/*`)

#### CPU Profiling
- `POST /profiling/cpu/start` - Start CPU profiling
- `POST /profiling/cpu/stop` - Stop and download CPU profile
- `GET /profiling/cpu/status` - Check if CPU profiling is running

#### Memory Profiling
- `POST /profiling/heap/snapshot` - Capture heap snapshot
- `GET /profiling/memory/health` - Memory health check (leak detection)
- `GET /profiling/profiles` - List all saved profile files
- `GET /profiling/profiles/:filename` - Download a specific profile file

### Observability Endpoints (`/observability/*`)

- `GET /observability/baselines` - Get performance baselines for all routes
- `GET /observability/regressions` - View detected performance regressions
- `POST /observability/baselines/reset` - Reset baselines after deployments
- `GET /observability/active-requests` - View currently processing requests
- `GET /observability/memory/current` - Real-time memory usage statistics

## Analyzing CPU Profiles

1. **Start profiling**:
   ```bash
   curl -X POST http://localhost:3000/profiling/cpu/start
   ```

2. **Generate load** on the application for 30-60 seconds to capture meaningful data

3. **Stop profiling and download**:
   ```bash
   curl -X POST http://localhost:3000/profiling/cpu/stop --output cpu-profile.cpuprofile
   ```

4. **Analyze in Chrome DevTools**:
   - Open Chrome and navigate to `chrome://inspect`
   - Click "Open DevTools"
   - Go to the "Performance" or "Memory" tab
   - Load the `.cpuprofile` file
   - Look for:
     - Functions with high self-time (hot functions)
     - Unexpected call frequencies
     - Blocking operations

## Analyzing Heap Snapshots

1. **Capture a heap snapshot**:
   ```bash
   curl -X POST http://localhost:3000/profiling/heap/snapshot
   ```

2. **Download the file** from the profiles directory

3. **Analyze in Chrome DevTools**:
   - Load the `.heapsnapshot` file in Chrome DevTools Memory tab
   - Use the "Retainers" view to find memory leaks
   - Look for:
     - Growing object counts over time
     - Detached DOM trees (if applicable)
     - Unexpectedly large objects
     - Objects that aren't being garbage collected

## Reading Request Timing Waterfalls

The application logs request timing data in JSON format:
```json
{
  "type": "request_timing",
  "method": "GET",
  "path": "/api/portfolio",
  "timings": {
    "middleware": 5,      // Middleware execution time (ms)
    "handler": 150,      // Route handler execution time (ms)
    "database": 120,     // Database query time (ms)
    "total": 155         // Total request duration (ms)
  },
  "waterfall": {
    "middleware": [0, 5],
    "handler": [5, 155],
    "database": [20, 140]
  }
}
```

Waterfall timings are relative to request start time, showing exactly where time is spent.

## Tracking Performance Regressions

The system automatically establishes baselines for route performance:
- Tracks P50, P95, and P99 latencies
- Alerts when a request is 50% slower than baseline P95
- Stores all detected regressions for analysis
- Reset baselines after deployments with `POST /observability/baselines/reset`

## Memory Leak Detection

The memory health check endpoint (`GET /profiling/memory/health`) monitors:
- Heap usage growth over time
- Memory growth thresholds
- Alerts on potential leaks

## Visualization Integration

All metrics are exposed to Prometheus and can be visualized in Grafana:
- Request duration histograms
- Baseline latency gauges
- Regression counter
- Memory usage metrics

Import the existing Grafana dashboard (in `docker/grafana/dashboards/`) to get pre-built visualizations.

## Best Practices

1. **Profile in staging first**: Avoid running CPU/memory profiling in production unless necessary
2. **Keep profiling sessions short**: CPU profiling adds minimal overhead but should still be limited
3. **Compare against baselines**: Always compare new profiles against established baselines
4. **Take multiple heap snapshots**: Memory leaks are best identified by comparing snapshots over time
5. **Look at database timings**: Most application bottlenecks are database-related
6. **Check hot functions**: CPU profiling often reveals inefficient algorithms or unexpected N+1 queries

## Troubleshooting

### Can't connect to inspector?
- Ensure Node.js version >= 16 (the inspector API is stable in newer versions)
- The application must be run with `--inspect` flag in development
- In production, profiling is disabled by default (set `ENABLE_PROFILING=true` to enable)

### Profiles not being saved?
- Check that the `profiles/` directory exists and has proper permissions
- Verify disk space is available
- Check application logs for errors during profile creation

### Regressions being flagged incorrectly?
- Reset baselines after any major deployment
- Adjust the `regressionThreshold` in `performance-baseline.service.ts` if needed
- Ensure sufficient data has been collected to establish accurate baselines