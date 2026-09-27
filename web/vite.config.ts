import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // В dev API крутится отдельно (npm run dev:server).
    proxy: { '/api': 'http://localhost:3000' },
  },
});
