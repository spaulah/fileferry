import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Inline compiler options, so Vite does not search parent folders for a tsconfig.json.
  esbuild: {
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', target: 'ES2022', useDefineForClassFields: true } }
  },
  build: {
    target: 'es2022'
  }
});
