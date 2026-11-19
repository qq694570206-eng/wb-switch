#!/bin/sh
# wb-switch-mcp —— MCP 启动器（由 wb-switch 应用安装）
#
# 为什么需要它：
#   MCP 客户端启动子进程时只带应用自身环境，PATH 往往就是 /usr/bin:/bin，
#   既找不到 `wb-switch` 命令，也可能找不到 node 运行时。
#   这里自行定位 node，再执行同目录下的 wb-switch 单文件 CLI。
#
# 用法：wb-switch-mcp mcp
set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for n in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node \
           /opt/homebrew/bin/node /usr/local/bin/node \
           /usr/bin/node /bin/node; do
    [ -x "$n" ] && { printf '%s\n' "$n"; return 0; }
  done
  return 1
}

NODE=$(find_node) || {
  echo "wb-switch-mcp: 未找到 node 运行时；请安装 Node.js，或启动一次 wb-switch 应用后重试" >&2
  exit 127
}

exec "$NODE" "$DIR/wb-switch" "$@"
