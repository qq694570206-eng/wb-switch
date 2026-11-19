/** 允许把 .sh 脚本当字符串引入（esbuild loader: text；tsc 仅做类型检查，运行时由打包器处理） */
declare module '*.sh' {
  const content: string;
  export default content;
}
