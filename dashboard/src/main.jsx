import { createRoot } from 'react-dom/client';
import './style.css';
import App from './App.jsx';
// 개발 폴백(서버 없이 브라우저만으로 1단계처럼 돌리고 싶을 때): mock-stream.js 를 참고.
// mock-stream.js 는 이 용도로 남겨둔다(공개 API 가 ws-client 와 동일).

createRoot(document.getElementById('root')).render(<App />);
