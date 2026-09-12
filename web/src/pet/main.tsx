import { createRoot } from 'react-dom/client'
import App from './App'
import './pet.css'

// deliberately not StrictMode: its dev double-mount would start two simulation workers
createRoot(document.getElementById('root')!).render(<App />)
