// Tells TypeScript that .html imports are strings (esbuild inlines them via loader: { ".html": "text" })
declare module "*.html" {
  const content: string;
  export default content;
}
