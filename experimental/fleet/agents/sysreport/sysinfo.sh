#!/bin/sh
# Prints a plain-text snapshot of machine utilization. Works on macOS and Linux.

echo "== host"
echo "$(hostname) · $(uname -sm)"

echo "== uptime / load"
uptime

case "$(uname -s)" in
  Darwin)
    echo "== cpu"
    sysctl -n machdep.cpu.brand_string 2>/dev/null
    echo "cores: $(sysctl -n hw.ncpu)"
    top -l 1 -n 0 | grep -E "^(CPU usage|PhysMem|Load Avg|Processes)"
    echo "== memory"
    echo "total: $(( $(sysctl -n hw.memsize) / 1073741824 )) GiB"
    memory_pressure 2>/dev/null | tail -1
    sysctl -n vm.swapusage
    echo "== top processes by cpu"
    ps -Ao pcpu,pmem,comm -r | head -6
    ;;
  *)
    echo "== cpu"
    echo "cores: $(nproc)"
    top -bn1 | grep -E "^(%Cpu|Tasks)"
    echo "== memory"
    free -h
    echo "== top processes by cpu"
    ps -eo pcpu,pmem,comm --sort=-pcpu | head -6
    ;;
esac

echo "== disk"
df -h / | tail -1
