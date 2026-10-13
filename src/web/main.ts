// Entry for the browser build: window.api must exist before the renderer's modules run.
import './api'
import '../renderer/src/main'
