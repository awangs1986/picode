#!/bin/bash


# Arrays to store task information
declare -a task_pids
declare -a task_names

# Function to run command in background and track it
run_background() {
  local name="$1"
  shift
  echo "[$name] Starting..." >&2
  local log_file="/tmp/${name}.log"
  touch "$log_file"
  "$@" > "$log_file" 2>&1 &
  local pid=$!
  echo "[$name] Started (PID: $pid)" >&2
  task_pids+=("$pid")
  task_names+=("$name")
}

# Function to wait for all background jobs and show results
wait_all() {
  local failed=0
  local total=${#task_pids[@]}
  
  for ((i=0; i<total; i++)); do
    local pid="${task_pids[$i]}"
    local name="${task_names[$i]}"
    
    wait "$pid" 2>/dev/null
    local exit_code=$?
    local log_file="/tmp/${name}.log"
    
    if [ $exit_code -eq 0 ]; then
      echo "[$name] ✓ Completed successfully"
    else
      echo ""
      echo "[$name] ✗ Failed with exit code $exit_code"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      if [ -f "$log_file" ] && [ -s "$log_file" ]; then
        echo "[$name] Full output:"
        cat "$log_file"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      else
        echo "[$name] No log file available"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      fi
      failed=$((failed + 1))
    fi
    rm -f "$log_file"
  done
  
  return $failed
}

echo "Starting parallel execution of lint, format, check, and cleanup tasks..."
echo ""

# Start all tasks in parallel
run_background "lint:fix" bun run lint:fix
run_background "format:fix" bun run format:fix
run_background "check:fix" bun run check:fix

# Wait for all background jobs to complete
echo ""
echo "Waiting for all tasks to complete..."
echo ""

overall_failed=0

if wait_all; then
  echo ""
else
  echo ""
  echo "✗ Some tasks failed. Continuing to parity check..."
  overall_failed=1
fi



if [ $overall_failed -eq 0 ]; then
  echo "✓ All tasks completed successfully!"
else
  echo "✗ Some tasks failed. Please check the output above."
  exit 1
fi
