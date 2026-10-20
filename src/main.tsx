import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

class Guard extends Component<{ children: ReactNode }, { err?: Error }> {
  state: { err?: Error } = {}
  static getDerivedStateFromError(err: Error) { return { err } }
  render() {
    return this.state.err
      ? <pre style={{ padding: 20, color: '#c00', whiteSpace: 'pre-wrap' }}>{this.state.err.stack ?? String(this.state.err)}</pre>
      : this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><Guard><App /></Guard></StrictMode>,
)
