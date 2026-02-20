/**
 * @file /src/utils/buildPageView.ts
 * @name BuildPageView
 * @description Utility functions for building the page view.
 */

import { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { PaginationOptions } from "../PaginationExtension";
import { MIN_PARAGRAPH_HEIGHT } from "../constants/pagination";
import { NodePosArray } from "../types/node";
import { CursorMap } from "../types/cursor";
import { Nullable, Undefinable } from "../types/record";
import { MarginConfig } from "../types/page";
import {
    moveToNearestValidCursorPosition,
    moveToThisTextBlock,
    setSelection,
    setSelectionAtEndOfDocument,
} from "./selection";
import { inRange } from "./math";
import { getPaginationNodeAttributes } from "./nodes/page/attributes/getPageAttributes";
import { isParagraphNode } from "./nodes/paragraph";
import { isTextNode } from "./nodes/text";
import { getPaginationNodeTypes } from "./pagination";
import { isPageNumInRange } from "./nodes/page/pageRange";
import { HeaderFooter, HeaderFooterNodeAttributes } from "../types/pageRegions";
import { getPageRegionNode } from "./pageRegion/getAttributes";
import { getMaybeNodeSize } from "./nodes/node";
import { isPageNode } from "./nodes/page/page";
import { isHeaderFooterNode } from "./nodes/headerFooter/headerFooter";
import { isBodyNode } from "./nodes/body/body";
import { Editor } from "@tiptap/core";
import { isPageBreakNode } from "./nodes/pageBreak/pageBreak";

/**
 * Builds a new document with paginated content.
 */
export const buildPageView = (editor: Editor, view: EditorView, options: PaginationOptions): void => {
    const { state, dispatch } = view;
    const { doc } = state;

    try {
        const contentNodes = collectContentNodes(doc);

        // ⚠️ Cambios: medimos alturas, pero pageBreak debe medir 0 (no MIN_PARAGRAPH_HEIGHT)
        const nodeHeights = measureNodeHeights(view, contentNodes);

        const { tr, selection } = state;
        const oldCursorPos = selection.from;

        const { newDoc, oldToNewPosMap } = buildNewDocument(editor, options, contentNodes, nodeHeights);

        if (!newDoc.content.eq(doc.content)) {
            tr.replaceWith(0, doc.content.size, newDoc.content);
            tr.setMeta("pagination", true);

            const newDocContentSize = newDoc.content.size;
            const newCursorPos = mapCursorPosition(contentNodes, oldCursorPos, oldToNewPosMap, newDocContentSize);
            paginationUpdateCursorPosition(tr, newCursorPos);
        }

        dispatch(tr);
    } catch (error) {
        console.error("Error updating page view. Details:", error);
    }
};

/**
 * Collect content nodes and their existing positions.
 */
const collectContentNodes = (doc: PMNode): NodePosArray => {
    const contentNodes: NodePosArray = [];
    doc.forEach((pageNode, pageOffset) => {
        if (isPageNode(pageNode)) {
            pageNode.forEach((pageRegionNode, pageRegionOffset) => {
                const truePageRegionOffset = pageRegionOffset + 1;

                if (isHeaderFooterNode(pageRegionNode)) {
                    // skip header/footer
                } else if (isBodyNode(pageRegionNode)) {
                    pageRegionNode.forEach((child, childOffset) => {
                        const trueChildOffset = childOffset + 1;
                        contentNodes.push({ node: child, pos: pageOffset + truePageRegionOffset + trueChildOffset });
                    });
                } else {
                    contentNodes.push({ node: pageRegionNode, pos: pageOffset + truePageRegionOffset });
                }
            });
        } else {
            contentNodes.push({ node: pageNode, pos: pageOffset + 1 });
        }
    });

    return contentNodes;
};

const calculateElementMargins = (element: HTMLElement): MarginConfig => {
    const style = window.getComputedStyle(element);
    return {
        top: parseFloat(style.marginTop),
        right: parseFloat(style.marginRight),
        bottom: parseFloat(style.marginBottom),
        left: parseFloat(style.marginLeft),
    };
};

/**
 * Measure heights of the content nodes.
 *
 * ⚠️ Cambio clave: pageBreak => altura 0 siempre
 */
const measureNodeHeights = (view: EditorView, contentNodes: NodePosArray): number[] => {
    const paragraphType = view.state.schema.nodes.paragraph;

    const nodeHeights = contentNodes.map(({ pos, node }) => {
        // ✅ pageBreak no debe “contar” como altura, o se comporta como newline lógico
        if (isPageBreakNode(node)) return 0;

        const domNode = view.nodeDOM(pos);

        if (domNode instanceof HTMLElement) {
            let { height } = domNode.getBoundingClientRect();
            const { top: marginTop } = calculateElementMargins(domNode);

            if (height === 0) {
                if (node.type === paragraphType || node.isTextblock) {
                    height = MIN_PARAGRAPH_HEIGHT;
                }
            }

            return height + marginTop;
        }

        return MIN_PARAGRAPH_HEIGHT;
    });

    return nodeHeights;
};

const buildNewDocument = (
    editor: Editor,
    options: PaginationOptions,
    contentNodes: NodePosArray,
    nodeHeights: number[]
): { newDoc: PMNode; oldToNewPosMap: CursorMap } => {
    const { schema, doc } = editor.state;
    const { pageAmendmentOptions } = options;
    const {
        pageNodeType: pageType,
        headerFooterNodeType: headerFooterType,
        bodyNodeType: bodyType,
        paragraphNodeType: paragraphType,
    } = getPaginationNodeTypes(schema);

    let pageNum = 0;
    const pages: PMNode[] = [];
    let existingPageNode: Nullable<PMNode> = doc.maybeChild(pageNum);
    let { pageNodeAttributes, pageRegionNodeAttributes, bodyPixelDimensions } = getPaginationNodeAttributes(editor, pageNum);

    const constructHeaderFooter =
        <HF extends HeaderFooter>(pageRegionType: HeaderFooter) =>
            (headerFooterAttrs: HeaderFooterNodeAttributes<HF>): PMNode | undefined => {
                if (!headerFooterType) return;

                if (existingPageNode) {
                    const hfNode = getPageRegionNode(existingPageNode, pageRegionType);
                    if (hfNode) return hfNode;
                }

                const emptyParagraph = paragraphType.create();
                return headerFooterType.create(headerFooterAttrs, [emptyParagraph]);
            };

    const constructHeader = <HF extends HeaderFooter>(headerFooterAttrs: HeaderFooterNodeAttributes<HF>) => {
        if (!pageAmendmentOptions.enableHeader) return;
        return constructHeaderFooter("header")(headerFooterAttrs);
    };

    const constructFooter = <HF extends HeaderFooter>(headerFooterAttrs: HeaderFooterNodeAttributes<HF>) => {
        if (!pageAmendmentOptions.enableFooter) return;
        return constructHeaderFooter("footer")(headerFooterAttrs);
    };

    const constructPageRegions = (currentPageContent: PMNode[]): PMNode[] => {
        const { body: bodyAttrs, footer: footerAttrs } = pageRegionNodeAttributes;
        const pageBody = bodyType.create(bodyAttrs, currentPageContent);
        const pageFooter = constructFooter(footerAttrs);

        const pageRegions: Undefinable<PMNode>[] = [currentPageHeader, pageBody, pageFooter];
        return pageRegions.filter((region) => !!region);
    };

    const addPage = (currentPageContent: PMNode[]): PMNode => {
        const pageNodeContents = constructPageRegions(currentPageContent);
        const pageNode = pageType.create(pageNodeAttributes, pageNodeContents);
        pages.push(pageNode);
        return pageNode;
    };

    let currentPageHeader: PMNode | undefined = constructHeader(pageRegionNodeAttributes.header);
    let currentPageContent: PMNode[] = [];
    let currentHeight = 0;

    const oldToNewPosMap: CursorMap = new Map<number, number>();

    const pageOffset = 1;
    const bodyOffset = 1;

    let cumulativeNewDocPos = pageOffset + getMaybeNodeSize(currentPageHeader) + bodyOffset;
    let endedWithPageBreak = false;

    for (let i = 0; i < contentNodes.length; i++) {
        const { node, pos: oldPos } = contentNodes[i];
        const nodeHeight = nodeHeights[i];

        // ✅ Cambio clave: pageBreak corta página, pero NO se guarda y NO se mapea
        // y NO debe afectar height/cursor mapping.
        if (isPageBreakNode(node)) {
            const pageNode = addPage(currentPageContent);

            cumulativeNewDocPos += pageNode.nodeSize - getMaybeNodeSize(currentPageHeader);
            currentPageContent = [];
            currentHeight = 0;

            existingPageNode = doc.maybeChild(++pageNum);
            if (isPageNumInRange(doc, pageNum)) {
                ({ pageNodeAttributes, pageRegionNodeAttributes, bodyPixelDimensions } =
                    getPaginationNodeAttributes(editor, pageNum));
            }

            currentPageHeader = constructHeader(pageRegionNodeAttributes.header);
            cumulativeNewDocPos += getMaybeNodeSize(currentPageHeader);

            endedWithPageBreak = true;
            continue;
        }

        endedWithPageBreak = false;

        const isPageFull = currentHeight + nodeHeight > bodyPixelDimensions.bodyHeight;
        if (isPageFull && currentPageContent.length > 0) {
            const pageNode = addPage(currentPageContent);

            cumulativeNewDocPos += pageNode.nodeSize - getMaybeNodeSize(currentPageHeader);
            currentPageContent = [];
            currentHeight = 0;

            existingPageNode = doc.maybeChild(++pageNum);
            if (isPageNumInRange(doc, pageNum)) {
                ({ pageNodeAttributes, pageRegionNodeAttributes, bodyPixelDimensions } =
                    getPaginationNodeAttributes(editor, pageNum));
            }

            currentPageHeader = constructHeader(pageRegionNodeAttributes.header);
            cumulativeNewDocPos += getMaybeNodeSize(currentPageHeader);
        }

        // ⚠️ Cambio: no queremos mapear “puntos” si nodeHeight 0 por alguna razón rara,
        // pero aquí SOLO pageBreak es 0 y ya lo filtramos arriba.
        const nodeStartPosInNewDoc = cumulativeNewDocPos + currentPageContent.reduce((sum, n) => sum + n.nodeSize, 0);
        oldToNewPosMap.set(oldPos, nodeStartPosInNewDoc);

        currentPageContent.push(node);
        currentHeight += nodeHeight;
    }

    if (endedWithPageBreak) {
        addPage([]);
    } else if (currentPageContent.length > 0) {
        addPage(currentPageContent);
    }

    const newDoc = schema.topNodeType.create(null, pages);
    const docSize = newDoc.content.size;
    limitMappedCursorPositions(oldToNewPosMap, docSize);

    return { newDoc, oldToNewPosMap };
};

const limitMappedCursorPositions = (oldToNewPosMap: CursorMap, docSize: number): void => {
    oldToNewPosMap.forEach((newPos, oldPos) => {
        if (newPos > docSize) {
            oldToNewPosMap.set(oldPos, docSize);
        }
    });
};

/**
 * Map cursor position old -> new.
 *
 * ✅ Cambio: si el cursor estaba “sobre” pageBreak, lo movemos al siguiente bloque válido.
 */
const mapCursorPosition = (
    contentNodes: NodePosArray,
    oldCursorPos: number,
    oldToNewPosMap: CursorMap,
    newDocContentSize: number
) => {
    let newCursorPos: Nullable<number> = null;

    for (let i = 0; i < contentNodes.length; i++) {
        const { node, pos: oldNodePos } = contentNodes[i];
        const nodeSize = node.nodeSize;

        if (inRange(oldCursorPos, oldNodePos, oldNodePos + nodeSize)) {
            // ✅ Si cae en pageBreak, saltamos al próximo nodo “real”
            if (isPageBreakNode(node)) {
                // intenta mapear el siguiente nodo
                for (let j = i + 1; j < contentNodes.length; j++) {
                    const next = contentNodes[j];
                    if (!isPageBreakNode(next.node)) {
                        const mapped = oldToNewPosMap.get(next.pos);
                        newCursorPos = mapped !== undefined ? Math.min(mapped, newDocContentSize - 1) : newDocContentSize - 1;
                        return newCursorPos;
                    }
                }
                // si no hay siguiente, al final
                return newDocContentSize - 1;
            }

            const offsetInNode = oldCursorPos - oldNodePos;
            const newNodePos = oldToNewPosMap.get(oldNodePos);

            if (newNodePos === undefined) {
                console.error("Unable to determine new node position from cursor map!");
                newCursorPos = 0;
            } else {
                newCursorPos = Math.min(newNodePos + offsetInNode, newDocContentSize - 1);
            }

            break;
        }
    }

    return newCursorPos;
};

const isNodeBeforeAvailable = ($pos: ResolvedPos): boolean => {
    return !!$pos.nodeBefore && (isTextNode($pos.nodeBefore) || isParagraphNode($pos.nodeBefore));
};

const isNodeAfterAvailable = ($pos: ResolvedPos): boolean => {
    return !!$pos.nodeAfter && (isTextNode($pos.nodeAfter) || isParagraphNode($pos.nodeAfter));
};

const paginationUpdateCursorPosition = (tr: Transaction, newCursorPos: Nullable<number>): void => {
    if (newCursorPos !== null) {
        const $pos = tr.doc.resolve(newCursorPos);
        let selection;

        if ($pos.parent.isTextblock || isNodeBeforeAvailable($pos) || isNodeAfterAvailable($pos)) {
            selection = moveToThisTextBlock(tr, $pos);
        } else {
            selection = moveToNearestValidCursorPosition($pos);
        }

        if (selection) {
            setSelection(tr, selection);
        } else {
            setSelectionAtEndOfDocument(tr);
        }
    } else {
        setSelectionAtEndOfDocument(tr);
    }
};
