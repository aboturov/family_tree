import { createContext, useContext } from 'react';

/** Может ли пользователь править дерево и как обновить данные после сохранения. */
export type Editing = { canEdit: boolean; reload: () => Promise<void> };

const EditingContext = createContext<Editing>({ canEdit: false, reload: async () => {} });
export const EditingProvider = EditingContext.Provider;
export const useEditing = () => useContext(EditingContext);
