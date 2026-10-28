import './components/clip-editor.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { isMac } from './lib/utils'
import './globals.css'

if (isMac) document.documentElement.classList.add('vibrant')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
