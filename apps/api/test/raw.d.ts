// Vite's `?raw` imports: a file's text, for tests that check a shipped file.
declare module "*?raw" {
  const text: string;
  export default text;
}
