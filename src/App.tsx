import Home from "@/pages/Home";
import Album from "@/pages/Album";
import { HashRouter, Route, Routes } from "react-router-dom";

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/album" element={<Album />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </HashRouter>
  );
}
