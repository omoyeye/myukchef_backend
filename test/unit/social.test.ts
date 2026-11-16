// Unit tests for chef video links and the weekly report weeks. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { youtubeIdFrom } from "../../src/lib/youtube";
import { weekRange } from "../../src/lib/weeklyReports";

describe("YouTube links", () => {
    const id = "dQw4w9WgXcQ";
    it("reads the video id from every normal kind of link", () => {
        for (const link of [
            `https://www.youtube.com/watch?v=${id}`,
            `https://youtube.com/watch?v=${id}&t=10s`,
            `https://m.youtube.com/watch?feature=share&v=${id}`,
            `https://youtu.be/${id}?si=abc`,
            `https://www.youtube.com/shorts/${id}`,
            `youtube.com/shorts/${id}?feature=share`,
            `https://www.youtube.com/embed/${id}`,
            `https://www.youtube-nocookie.com/embed/${id}`,
            id,
        ]) assert.equal(youtubeIdFrom(link), id, link);
    });
    it("refuses anything that isn't a YouTube video", () => {
        for (const link of ["https://vimeo.com/123", "https://evil.example/watch?v=dQw4w9WgXcQ", "https://youtube.com/", "https://youtu.be/short", "", null, 42])
            assert.equal(youtubeIdFrom(link), null, String(link));
    });
});

describe("Report weeks", () => {
    it("last week runs Monday to Monday, UK time, in winter", () => {
        // Wednesday 18 November 2026, GMT.
        const w = weekRange(1, new Date("2026-11-18T15:00:00Z"));
        assert.equal(w.from.toISOString(), "2026-11-09T00:00:00.000Z");
        assert.equal(w.to.toISOString(), "2026-11-16T00:00:00.000Z");
        assert.equal(w.label, "9 Nov to 15 Nov");
    });
    it("uses UK midnight in summer time", () => {
        // Monday 6 July 2026, 07:30 BST (06:30 UTC). Last week started Monday 29 June at 00:00 BST.
        const w = weekRange(1, new Date("2026-07-06T06:30:00Z"));
        assert.equal(w.from.toISOString(), "2026-06-28T23:00:00.000Z");
        assert.equal(w.to.toISOString(), "2026-07-05T23:00:00.000Z");
    });
    it("a Sunday late at night still belongs to that week", () => {
        const w = weekRange(0, new Date("2026-11-22T23:30:00Z"));
        assert.equal(w.from.toISOString(), "2026-11-16T00:00:00.000Z");
    });
});
