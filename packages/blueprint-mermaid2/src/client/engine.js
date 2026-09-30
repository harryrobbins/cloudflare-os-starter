/* global gadget */
export async function renderDiagram({ source, language, layout, theme, sketch }) {
  const result = await gadget.renderDiagram({ source, language, layout, theme: Number(theme), sketch, format: 'svg' });
  return { svg: new TextDecoder().decode(result.data), d2Source: result.d2Source, layout, nodes: result.nodes, edges: result.edges };
}
