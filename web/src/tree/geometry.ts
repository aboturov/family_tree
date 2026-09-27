// Размеры карточек и форма результата раскладки. Отдельно от layout.ts, чтобы схема дерева
// не тянула ELK (~1,5 МБ): сама раскладка считается на сервере (server/src/layouts.ts).

// Карточка как в familio: круглый аватар сверху, под ним бейдж и подписи.
export const CARD = { width: 150, height: 190 };
export const AVATAR = { radius: 50, cy: 50 };
export const UNKNOWN_CARD = { width: 100, height: 190 };
/** «По родам»: карточка-ссылка на ребёнка, которого рисуют в роду супруга. */
export const REF_CARD = { width: 150, height: 72 };

/**
 * compact — супруги рядом, человек с двумя браками стоит между супругами;
 * bridges — муж слева, жёны справа по порядку браков; несоседний брак — прямой линией за
 *   карточками (как в familio), чуть выше линии соседнего брака, чтобы пунктир развода с ней
 *   не сливался. Дети такого брака спускаются в свободный промежуток между супругами.
 * Блоки, которые нельзя нарисовать компактно (три брака с детьми и сложнее), всегда идут как bridges.
 */
export type MarriageStyle = 'compact' | 'bridges';

export type PlacedPerson = { id: number; x: number; y: number };
/** Карточка «?» для неизвестного партнёра в семье, где есть дети. */
export type PlacedUnknown = { familyId: number; x: number; y: number };
/**
 * Брак. Соседний — линия между аватарами, дети — вниз из её середины. Несоседний (bridge) —
 * прямая за карточками чуть выше; дети — вертикалью с неё в свободном промежутке между
 * супругами (или сбоку от второго супруга, если свободного промежутка нет).
 */
export type PlacedUnion = {
  familyId: number;
  kind: 'adjacent' | 'bridge';
  path: { x: number; y: number }[];
  stem: { x: number; from: number; to: number } | null;
};
/** Линия от брака к ребёнку (или к ссылке на него в «По родам»). */
export type PlacedEdge = { id: string; familyId: number; childId: number; points: { x: number; y: number }[] };
/**
 * «По родам»: пара стоит в роду одного супруга, а в семье родителей другого на месте ребёнка —
 * ссылка на него (ref), над его карточкой — пометка «↑ родители» (portal), ведущая к ссылке.
 * via — через кого человек висит на своём месте: супруг (пара в роду супруга) или он сам
 * (у него две родительские семьи, например родная и приёмная).
 */
export type PlacedRef = { personId: number; familyId: number; via: number; x: number; y: number };
export type PlacedPortal = { personId: number; x: number; y: number };
/** «По родам»: подпись рода над его верхней парой; род называется по фамилии personId. x — середина пары. */
export type PlacedClan = { personId: number; x: number; y: number };
export type Layout = {
  persons: PlacedPerson[];
  unknowns: PlacedUnknown[];
  unions: PlacedUnion[];
  edges: PlacedEdge[];
  refs: PlacedRef[];
  portals: PlacedPortal[];
  clans: PlacedClan[];
  width: number;
  height: number;
};

/** Как раскладывать: layered — ELK одним графом («Семья», «Родня», «Всё дерево»), clans — по родам. */
export type LayoutAlgorithm = 'layered' | 'clans';

/** Промежутки между рядами: wide — во «Всём дереве», где между рядами идут десятки линий к детям. */
export type RowSpacing = 'compact' | 'wide';
