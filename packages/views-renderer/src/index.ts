/**
 * @use-brian/views-renderer — public exports.
 *
 * See ./CLAUDE.md for the package's role and the A2UI v0.8 catalog.
 */

export { ViewRenderer, renderWidget, renderRowValue } from './render.js'
export type {
  ActionRef,
  A2UIWidget,
  A2UIColumn,
  A2UIRow,
  A2UIRowValue,
  A2UIBoardCard,
  A2UIBoardColumn,
  ContainerWidget,
  HeadingWidget,
  TextWidget,
  BadgeWidget,
  ButtonWidget,
  ImageWidget,
  TableWidget,
  ListWidget,
  BoardWidget,
  GalleryWidget,
  TimelineWidget,
  KpiWidget,
  BarChartWidget,
  LineChartWidget,
  PieChartWidget,
  DiagramWidget,
  ViewPayload,
  OnActionHandler,
  ColumnMenuLabels,
  RenderWidgetOpts,
  ViewRendererProps,
} from './types.js'
export { PROPERTIES } from './properties/index.js'
export type {
  PropertyModule,
  PropertyCellProps,
  PropertyEditorProps,
  PropertyEditorHints,
  PropertyIconProps,
} from './properties/types.js'
export { Badge } from './widgets/Badge.js'
export { Board, interpolateCardSchema } from './widgets/Board.js'
export { Button } from './widgets/Button.js'
export { ChartBar } from './widgets/ChartBar.js'
export { ChartLine } from './widgets/ChartLine.js'
export { ChartPie } from './widgets/ChartPie.js'
export { Container } from './widgets/Container.js'
export { Diagram } from './widgets/Diagram.js'
export { Fallback } from './widgets/Fallback.js'
export { Gallery } from './widgets/Gallery.js'
export { Heading } from './widgets/Heading.js'
export { Image } from './widgets/Image.js'
export { Kpi } from './widgets/Kpi.js'
export { List } from './widgets/List.js'
export { Table } from './widgets/Table.js'
export { Text } from './widgets/Text.js'
export { Timeline } from './widgets/Timeline.js'
