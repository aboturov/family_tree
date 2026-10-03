import { createContext, useContext } from 'react';
import type { DocumentInput, DocumentView } from '../api.ts';

/**
 * Документы грузятся отдельно от дерева (GET /api/documents) и обновляются вместе с ним — тем
 * же reload после правки. Окно документа одно на приложение: его открывают из ленты событий,
 * вкладки человека и страницы «Документы».
 */
export type Documents = {
  /** undefined — ещё грузятся. */
  byId: Map<number, DocumentView> | undefined;
  error?: string;
  open: (id: number) => void;
  /** Новый документ; preset — например, человек, с чьей карточки его добавляют. */
  create: (preset?: Partial<DocumentInput>) => void;
};

const DocumentsContext = createContext<Documents>({ byId: undefined, open: () => {}, create: () => {} });
export const DocumentsProvider = DocumentsContext.Provider;
export const useDocuments = () => useContext(DocumentsContext);
