"""Opt-in live provider smoke test. Requires a running, configured local server; incurs API usage."""

import io
import json
import os
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

load_dotenv()


def sample_pdf():
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
    )
    stream = DecodedStreamObject()
    stream.set_data(
        b"BT /F1 12 Tf 50 700 Td (The Cedar pilot has 37 solar panels.) Tj 0 -20 Td (Each panel produces 410 watts. The project lead is Maya.) Tj ET"
    )
    page[NameObject("/Contents")] = writer._add_object(stream)
    target = io.BytesIO()
    writer.write(target)
    return target.getvalue()


def main():
    results = []
    created = []
    with httpx.Client(base_url="http://127.0.0.1:8000", timeout=280) as client:
        config = client.get("/api/config").json()
        if config["auth_required"]:
            client.post("/api/login", json={"password": os.environ["APP_ACCESS_TOKEN"]}).raise_for_status()
        settings = {
            **config["defaults"],
            "embedding_model": "Qwen/Qwen3-Embedding-8B",
            "max_tokens": 2048,
            "answer_style": "concise",
        }
        models = client.get("/api/models")
        models.raise_for_status()
        ids = [m["id"] for m in models.json()["models"]]
        assert settings["chat_model"] in ids
        assert settings["embedding_model"] in ids
        results.append({"test": "authenticated model catalog", "status": "passed", "models": len(ids)})
        print("PASS: authenticated catalog", len(ids), "models", flush=True)

        def answer(name, question, source_ids, opts, required=None):
            started = time.monotonic()
            data = {"question": question, "source_ids": source_ids, "settings": {**settings, **opts}}
            events = []
            with client.stream("POST", "/api/chat", json=data) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if line:
                        event = json.loads(line)
                        events.append(event)
                        if event["type"] == "error":
                            raise RuntimeError(event["message"])
            assert events[-1]["type"] == "done"
            text = "".join(e.get("text", "") for e in events)
            refs = next(e["sources"] for e in events if e["type"] == "sources")
            assert text.strip() and refs
            assert any(f"[{r['id']}]" in text for r in refs), text
            if required:
                assert required.lower() in text.lower(), text
            result = {
                "test": name,
                "status": "passed",
                "model": data["settings"]["chat_model"],
                "seconds": round(time.monotonic() - started, 1),
                "answer": text,
                "sources": [{"title": r["title"], "url": r["url"], "page": r.get("page")} for r in refs],
            }
            results.append(result)
            print("PASS:", name, result["seconds"], "seconds", flush=True)
            print(text, flush=True)
            return refs

        try:
            pdf = client.post(
                "/api/sources/pdf",
                files={"file": ("cedar-pilot-smoke.pdf", sample_pdf(), "application/pdf")},
                data={"settings": json.dumps(settings)},
            )
            pdf.raise_for_status()
            pdf = pdf.json()
            created.append(pdf["id"])
            print("PASS: live PDF embeddings", pdf["chunks"], "chunks", flush=True)
            results.append(
                {
                    "test": "PDF parsing and live embeddings",
                    "status": "passed",
                    "model": settings["embedding_model"],
                    "chunks": pdf["chunks"],
                }
            )
            refs = answer(
                "PDF grounded answer",
                "How many solar panels are in the Cedar pilot? Name the project lead.",
                [pdf["id"]],
                {"web_search": False},
                "37",
            )
            assert refs[0]["page"] == 1
            answer(
                "Second chat model",
                "What is the power rating of each panel?",
                [pdf["id"]],
                {"web_search": False, "chat_model": "Qwen/Qwen3-30B-A3B-Instruct-2507"},
                "410",
            )
            web = client.post(
                "/api/sources/website",
                json={
                    "url": "https://nebius.com/media-kit",
                    "settings": {
                        **settings,
                        "include_domains": ["nebius.com"],
                        "extract_depth": "advanced",
                    },
                },
            )
            web.raise_for_status()
            web = web.json()
            created.append(web["id"])
            results.append(
                {
                    "test": "Tavily advanced extraction and Nebius indexing",
                    "status": "passed",
                    "chunks": web["chunks"],
                }
            )
            print("PASS: website extraction and embeddings", web["chunks"], "chunks", flush=True)
            client.delete("/api/messages").raise_for_status()
            refs = answer(
                "Website grounded answer",
                "Which file formats are offered for downloading the Nebius logo?",
                [web["id"]],
                {"web_search": False, "include_domains": ["nebius.com"]},
            )
            assert all(r["url"].startswith("https://nebius.com/") for r in refs)
            client.delete("/api/messages").raise_for_status()
            refs = answer(
                "Live advanced web search with domain restriction",
                "How does Tavily advanced search differ from basic search?",
                [],
                {
                    "web_search": True,
                    "include_domains": ["docs.tavily.com"],
                    "max_results": 3,
                    "search_depth": "advanced",
                },
            )
            assert all(r["url"].startswith("https://docs.tavily.com/") for r in refs)
            Path("docs/live-test-results.json").write_text(json.dumps(results, indent=2) + "\n")
        finally:
            Path("docs/live-test-results.json").write_text(json.dumps(results, indent=2) + "\n")
            for source_id in created:
                client.delete("/api/sources/" + source_id)
            client.delete("/api/messages")
    print("Live checks complete; temporary test sources and chat removed.", flush=True)


if __name__ == "__main__":
    main()
