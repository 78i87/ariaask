// The legacy build ships no .d.mts next to pdf.mjs; its API surface matches
// the main entry, which does ship types.
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export * from "pdfjs-dist";
}
