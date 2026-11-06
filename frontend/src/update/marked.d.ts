// marked 4.3 (already a dependency, glide-data-grid's) ships no types: the one function used here.
declare module "marked" {
  export const marked: {
    lexer(src: string, options?: { gfm?: boolean }): unknown[];
  };
}
