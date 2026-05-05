import Home from "@/pages/Home";
import Album from "@/pages/Album";
import AlbumAdmin from "@/pages/AlbumAdmin";
import { HashRouter, Route, Routes } from "react-router-dom";

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/album" element={<Album />} />
        <Route path="/album-admin" element={<AlbumAdmin />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </HashRouter>
  );
}
