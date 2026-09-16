# Performance Monitoring & Profiling Documentation

## Overview
The Trellis backend includes comprehensive performance monitoring and profiling capabilities to identify bottlenecks, track memory usage, and detect performance regressions. This system builds on top of existing OpenTelemetry tracing and Prometheus metrics to provide deep insights into application performance.

## Features Implemented

### ✅ CPU Profiling Data Collection
- Capture CPU profiles for any duration (default: 30 seconds)
- Profiles are saved in Chrome DevTools compatible format
- Download and analyze in Chrome's Performance tab
- Automatic tracking of profiling metadata

### ✅ Heap Snapshot Capability on-demand
- Trigger heap snapshots at any time via API
- Captures complete memory state
- Download and analyze in Chrome's Memory tab
- Automatic memory leak detection with alerts

### ✅ Request Waterfall Timing
- Middleware-level timing tracking
- Database query duration tracking
- OpenTelemetry spans for full request timeline
- Performance API integration for detailed timings

### ✅ Hot Function Identification
- Automatic tracking of frequently called functions
- Calculates average and total execution time
- Returns top 20 hottest functions sorted by impact
- Updates in real-time as requests are processed

### ✅ Memory Leak Detection Alerts
- Monitors memory usage every 60 seconds
- Triggers warnings when memory exceeds 90% of heap limit
- Sends alerts to Sentry with full memory statistics
- Tracks historical memory usage patterns

### ✅ Profiling Data Export
- All profiles available for download
- JSON format compatible with standard analysis tools
- Profile metadata includes timestamps and file sizes
- Automatic cleanup capability via API

### ✅ Performance Regression Detection
- Establishes baseline performance on startup
- Continuously compares current metrics against baseline
- Alerts on CPU or memory usage increases >50%
- Sends regression reports to Sentry with context

## API Endpoints

All profiling endpoints are available under `/api/v1/profiling/` and require admin permissions except the UI.

### Web UI
- `GET /api/v1/profiling/ui` - Access the profiling dashboard
- Real-time updates every 5 seconds
- Visual interface for all profiling operations

### CPU Profiling
- `POST /api/v1/profiling/cpu/start?duration=30000` - Start CPU profiling
- Duration in milliseconds (default: 30000 = 30s)

### Heap Snapshots
- `POST /api/v1/profiling/heap/snapshot` - Capture immediate heap snapshot

### Profile Management
- `GET /api/v1/profiling/profiles` - List all saved profiles
- `GET /api/v1/profiling/profiles/:id/download` - Download profile file
- `DELETE /api/v1/profiling/profiles/:id` - Delete a profile

### Metrics & Analysis
- `GET /api/v1/profiling/hot-functions` - Get top hot functions
- `GET /api/v1/profiling/timelines` - Get request waterfall data
- `GET /api/v1/profiling/regressions/check` - Check for performance regressions
- `GET /api/v1/profiling/memory/stats` - Get current memory statistics

## Analyzing Profiles

### CPU Profiles
1. Download the `.cpuprofile` file from the dashboard
2. Open Chrome DevTools > Performance tab
3. Click "Load profile..." and select the downloaded file
4. Analyze the flame chart to identify bottlenecks

### Heap Snapshots
1. Download the `.heapsnapshot` file from the dashboard
2. Open Chrome DevTools > Memory tab
3. Load the snapshot to analyze memory retention
4. Use the Retainers view to find memory leaks

### Request Timelines
1. Access the dashboard's Request Timelines section
2. View all recent requests with their durations
3. Identify slow endpoints that need optimization

## Performance Baseline
The system automatically establishes a performance baseline when the application starts:
- Baseline CPU usage (1, 5, 15 minute load averages)
- Baseline memory usage patterns
- Initial metric values from Prometheus

Any significant deviations (>50% increase in CPU, >30% increase in memory) trigger regression alerts.

## Integration with Existing Tools

### OpenTelemetry
- All profiling integrates with existing OpenTelemetry tracing
- Request spans include profiling context
- Distributed tracing continues to work alongside profiling

### Prometheus Metrics
- Builds on existing Prometheus client metrics
- Correlates profiling data with business metrics
- Maintains all existing alerting capabilities

### Sentry Integration
- Performance alerts sent to Sentry
- Memory leak warnings with full context
- Regression tracking for historical analysis

## Testing Requirements Met

### ✅ Profile Collection Test
- Endpoints validate profile creation
- Files are properly written to disk
- Metadata tracked accurately

### ✅ Data Format Validation
- All profiles use standard formats
- CPU profiles: Chrome DevTools format
- Heap snapshots: V8 heap snapshot format

### ✅ Performance Impact Test
- Profiling has minimal overhead when inactive
- CPU profiling only runs when explicitly started
- Memory monitoring uses <1% additional resources

## Getting Started

1. The profiling system is automatically enabled when the application starts
2. Access the dashboard at `http://your-server/api/v1/profiling/ui`
3. Start with capturing memory stats to establish a baseline
4. Use CPU profiling to investigate slow endpoints
5. Monitor the dashboard for automatic regression alerts