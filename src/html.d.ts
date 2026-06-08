// Tells TypeScript that .html imports are strings (esbuild inlines them via loader: { ".html": "text" })
declare module "*.html" {
  const content: string;
  export default content;
}

// .md skill files are inlined as text strings the same way (loader: { ".md": "text" })
declare module "*.md" {
  const content: string;
  export default content;
}
