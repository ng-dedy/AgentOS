import { z } from "zod";
import { defineTool } from "../types";

const Ops = z.enum(["uppercase", "lowercase", "titlecase", "trim", "reverse", "slugify", "word_count", "char_count"]);

export const textTransformTool = defineTool({
  name: "text_transform",
  description: "Apply a deterministic transformation to text: uppercase, lowercase, titlecase, trim, reverse, slugify, word_count or char_count.",
  inputSchema: z.object({ text: z.string().max(50_000), operation: Ops }).strict(),
  outputSchema: z.object({ operation: Ops, result: z.union([z.string(), z.number()]) }),
  permission: "tool:text_transform",
  risk: "safe",
  requiresApproval: false,
  timeoutMs: 1000,
  handler: async ({ text, operation }) => {
    const result = (() => {
      switch (operation) {
        case "uppercase":
          return text.toUpperCase();
        case "lowercase":
          return text.toLowerCase();
        case "titlecase":
          return text.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
        case "trim":
          return text.trim();
        case "reverse":
          return [...text].reverse().join("");
        case "slugify":
          return text
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        case "word_count":
          return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
        case "char_count":
          return [...text].length;
      }
    })();
    return { operation, result };
  },
});
