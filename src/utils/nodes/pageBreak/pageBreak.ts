// src/utils/nodes/pageBreak/pageBreak.ts
import { Node as PMNode } from "@tiptap/pm/model";

export const PAGE_BREAK_NODE_NAME = "pageBreak";

export const isPageBreakNode = (node: PMNode | null | undefined): boolean => {
    return !!node && node.type?.name === PAGE_BREAK_NODE_NAME;
};
