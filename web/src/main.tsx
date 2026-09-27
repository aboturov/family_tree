import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
// Шрифт — из своей сборки, а не с Google Fonts: внешний стиль в <head> блокирует
// отрисовку, и если Google у посетителя недоступен, сайт висит на пустой странице.
import '@fontsource/pt-serif/400.css';
import '@fontsource/pt-serif/400-italic.css';
import '@fontsource/pt-serif/700.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
