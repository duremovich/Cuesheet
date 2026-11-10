#!/usr/bin/env bash
# TEMPORARY (probe branch only): sample server latency and machine pressure during e2e.
out=${1:-probe}
mkdir -p "$out"
vmstat -t 1 > "$out/vmstat.log" 2>&1 &
(while true; do
  echo "$(date -u +%H:%M:%S.%3N) $(grep -h total /proc/pressure/cpu /proc/pressure/io /proc/pressure/memory 2>/dev/null | tr '\n' ' ')"
  sleep 1
done) > "$out/pressure.log" &
while true; do
  t=$(date -u +%H:%M:%S.%3N)
  h=$(curl -s -o /dev/null -m 30 -w "%{http_code} %{time_total}" http://localhost:4317/api/health)
  r=$(curl -s -o /dev/null -m 30 -w "%{http_code} %{time_total}" http://localhost:4317/robots.txt)
  echo "$t health=$h robots=$r"
  sleep 0.2
done > "$out/probe.log"
