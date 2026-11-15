// SPDX-License-Identifier: Apache-2.0

export const guideSections: {
  id: string;
  title: string;
  blocks: (
    | { kind: "p" | "code"; text: string }
    | { kind: "ul"; items: string[] }
    | { kind: "steps"; items: { label: string; text?: string; code?: string }[] }
  )[];
}[];
