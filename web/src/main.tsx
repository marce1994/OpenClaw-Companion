import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// Reset default styles
document.documentElement.style.margin = '0';
document.documentElement.style.padding = '0';
document.body.style.margin = '0';
document.body.style.padding = '0';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
