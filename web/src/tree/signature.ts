import { findEvent, type Tree } from './model.ts';

/**
 * Всё, от чего зависит раскладка (layout.ts, clans.ts): люди и семьи, кто чей супруг и ребёнок,
 * пол (кто в паре слева), даты рождения (порядок детей) и даты браков (порядок браков). Имя,
 * фамилии, биография, места, фото, «умер» и прочие события на неё не влияют — после такой
 * правки дерево не пересчитывается, карточки просто перерисовываются с новыми данными.
 */
export function layoutSignature(tree: Tree): string {
  return JSON.stringify([
    tree.persons.map((p) => [p.id, p.sex, findEvent(p.events, 'birth')?.date?.value ?? '']),
    tree.families.map((f) => [
      f.id,
      f.partners,
      f.children.map((c) => c.id),
      findEvent(f.events, 'marriage')?.date?.value ?? '',
    ]),
  ]);
}
