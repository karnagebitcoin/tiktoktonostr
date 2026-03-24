from __future__ import annotations

import asyncio
import os
import tempfile
from typing import Any
from urllib.parse import quote, urlparse

import yt_dlp
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

APP_HOST = os.getenv("TTN_WORKER_HOST", "0.0.0.0")
APP_PORT = int(os.getenv("TTN_WORKER_PORT", "8787"))
PUBLIC_BASE_URL = os.getenv("TTN_PUBLIC_BASE_URL", f"http://127.0.0.1:{APP_PORT}")

ALLOWED_HOSTS = {
    "tiktok.com",
    "www.tiktok.com",
    "m.tiktok.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
}

app = FastAPI(title="TikTok to Nostr Worker")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


def normalize_tiktok_url(raw_url: str) -> str:
    parsed = urlparse(raw_url.strip())
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Only http and https URLs are supported.")

    hostname = (parsed.hostname or "").lower()
    if hostname not in ALLOWED_HOSTS:
        raise HTTPException(status_code=400, detail="Only TikTok URLs are supported.")

    return parsed.geturl()


def ydl_opts() -> dict[str, Any]:
    return {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "cachedir": False,
        "extract_flat": False,
        "noplaylist": True,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
            )
        },
    }


def extract_info(url: str) -> dict[str, Any]:
    try:
        with yt_dlp.YoutubeDL(ydl_opts()) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as exc:
        raise HTTPException(status_code=502, detail=f"yt-dlp failed: {exc}") from exc

    if not isinstance(info, dict):
        raise HTTPException(status_code=502, detail="TikTok metadata was not returned as an object.")

    stream = select_stream(info)
    info["stream_url"] = stream["url"]
    info["stream_headers"] = stream["headers"]
    return info


def merge_stream_headers(*sources: dict[str, Any] | None) -> dict[str, str]:
    merged: dict[str, str] = {}
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key, value in source.items():
            if isinstance(value, str) and value.strip():
                merged[key] = value
    return merged


def select_stream(info: dict[str, Any]) -> dict[str, Any]:
    def build_stream_payload(candidate: dict[str, Any]) -> dict[str, Any] | None:
        candidate_url = candidate.get("url")
        if not isinstance(candidate_url, str) or not candidate_url.startswith(("http://", "https://")):
            return None

        headers = merge_stream_headers(info.get("http_headers"), candidate.get("http_headers"))
        cookies = candidate.get("cookies") or info.get("cookies")
        if isinstance(cookies, str) and cookies.strip():
            headers["Cookie"] = cookies

        return {
            "url": candidate_url,
            "headers": headers,
        }

    primary = build_stream_payload(info)
    if primary:
        return primary

    formats = info.get("formats")
    if isinstance(formats, list):
        for entry in reversed(formats):
            if not isinstance(entry, dict):
                continue
            stream = build_stream_payload(entry)
            if stream:
                return stream

    raise HTTPException(status_code=502, detail="Worker could not resolve a downloadable TikTok video URL.")


def build_payload(info: dict[str, Any], source_url: str) -> dict[str, Any]:
    stream_endpoint = f"{PUBLIC_BASE_URL.rstrip('/')}/api/tiktok/media?url={quote(source_url, safe='')}"
    title = info.get("title") or ""
    description = info.get("description") or ""
    uploader = info.get("uploader") or info.get("channel") or ""
    thumbnail = info.get("thumbnail") or ""
    webpage_url = info.get("webpage_url") or source_url
    video_id = info.get("id") or ""

    return {
        "ok": True,
        "title": title,
        "caption": description,
        "author_handle": uploader,
        "poster_url": thumbnail,
        "webpage_url": webpage_url,
        "video_id": video_id,
        "stream_url": stream_endpoint,
    }


def download_media_file(source_url: str) -> tuple[str, str]:
    fd, temp_path = tempfile.mkstemp(prefix="ttn-", suffix=".mp4")
    os.close(fd)
    os.unlink(temp_path)

    download_opts = {
        **ydl_opts(),
        "skip_download": False,
        "outtmpl": temp_path,
    }

    try:
        with yt_dlp.YoutubeDL(download_opts) as ydl:
            ydl.download([source_url])
    except yt_dlp.utils.DownloadError as exc:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise HTTPException(status_code=502, detail=f"yt-dlp media download failed: {exc}") from exc

    if not os.path.exists(temp_path) or os.path.getsize(temp_path) <= 0:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise HTTPException(status_code=502, detail="yt-dlp media download produced an empty file.")

    return temp_path, "video/mp4"


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/tiktok/resolve")
async def resolve_tiktok(url: str = Query(..., min_length=8)) -> JSONResponse:
    normalized_url = normalize_tiktok_url(url)
    info = extract_info(normalized_url)
    return JSONResponse(build_payload(info, normalized_url))


@app.get("/api/tiktok/media")
async def stream_tiktok_media(url: str = Query(..., min_length=8)) -> FileResponse:
    normalized_url = normalize_tiktok_url(url)
    temp_path, media_type = await asyncio.to_thread(download_media_file, normalized_url)
    response_headers = {
        "Cache-Control": "no-store",
    }

    def cleanup_temp_file() -> None:
        if os.path.exists(temp_path):
            os.unlink(temp_path)

    return FileResponse(
        path=temp_path,
        media_type=media_type,
        headers=response_headers,
        background=BackgroundTask(cleanup_temp_file),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=APP_HOST, port=APP_PORT)
