import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('FRACTURE: #root element is missing from index.html');
}

// `createRoot().render()` replaces the server-rendered splash markup.
createRoot(container).render(<App />);
