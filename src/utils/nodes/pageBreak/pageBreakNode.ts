// src/utils/nodes/pageBreak/pageBreakNode.ts
import { Node, mergeAttributes } from "@tiptap/core";

export const PAGE_BREAK_NODE_NAME = "pageBreak";

export const PageBreakNode = Node.create({
    name: PAGE_BREAK_NODE_NAME,

    /**
     * Importante:
     * - group: "block" para que pueda convivir entre bloques dentro de body.
     * - atom: true para que sea una unidad (no editable).
     * - isolating: true para que ProseMirror no intente “fusionarlo” raro con vecinos.
     * - selectable: false para que el cursor no se quede pegado ahí.
     */
    group: "block",
    atom: true,
    isolating: true,
    selectable: false,
    draggable: false,

    /**
     * Evita que se quede como “bloque vacío” visible.
     * `defining: true` ayuda a que el editor preserve este node con más fidelidad
     * en transforms.
     */
    defining: true,

    /**
     * Parse seguro para HTML import/export.
     * Nota: en tu código había un mismatch: parse buscaba data-page-break="true"
     * pero render ponía data-page-break (sin valor). Aquí lo alineamos.
     */
    parseHTML() {
        return [
            { tag: `div[data-page-break="true"]` },
            { tag: `span[data-page-break="true"]` },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        // Cero espacio real, cero márgenes, no seleccionable, no afecte layout
        // y sigue siendo exportable/importable.
        return [
            "span",
            mergeAttributes(HTMLAttributes, {
                "data-page-break": "true",
                "aria-hidden": "true",
                style: [
                    "display:block",
                    "height:0",
                    "line-height:0",
                    "margin:0",
                    "padding:0",
                    "border:0",
                    "overflow:hidden",
                    "pointer-events:none",
                ].join(";"),
            }),
        ];
    },
});
