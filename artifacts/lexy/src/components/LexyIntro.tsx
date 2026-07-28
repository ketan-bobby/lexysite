/**
 * LexyIntro.tsx — Animated brand intro / onboarding splash screen.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * A full-viewport cinematic intro composed of five timed scenes that play
 * sequentially with Framer Motion transitions.  Each scene layers animated text
 * headlines, a live Lexy avatar video (WebM with transparent background), the
 * Lexy logo, and particle / glow effects.  A mute/unmute button controls the
 * avatar video audio.  The component emits an `onComplete` callback when the
 * final scene finishes so the parent can unmount it and show the main app.
 *
 * ── Key sections ──────────────────────────────────────────────────────────────
 *  SCENE_DURATIONS[]   Duration (ms) for each of the 5 scenes
 *  DESIGN_W / DESIGN_H Canvas resolution; all sizes scale to fit the viewport
 *  <Scene{n}>          Individual animated scene components (Scene0–Scene4)
 *  <LexyIntro>         Root: scene timer, scale-to-fit observer, mute toggle,
 *                      avatar video element, scene switcher, skip button
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/login.tsx / App.tsx    Shown on first login before the dashboard loads
 */

import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const lexyLogo = `${import.meta.env.BASE_URL}lexy-logo.png`;
const lexyVideoSrc = `${import.meta.env.BASE_URL}videos/lexy-avatar-nobg.webm`;

// Design resolution — all sizing is authored at this size then scaled to fit
const DESIGN_W = 1280;
const DESIGN_H = 720;

const SCENE_DURATIONS = [4000, 4500, 5000, 4500, 5000];

const colors = {
  cyan: "#00E5FF",
  purple: "#c084fc",
  bg: "#050a0f",
};

export default function LexyIntro() {
  const [currentScene, setCurrentScene] = useState(0);
  const [isMuted, setIsMuted] = useState(true);
  const [scale, setScale] = useState(1);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Scale inner canvas to fit the outer container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setScale(Math.min(width / DESIGN_W, height / DESIGN_H));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document.getElementById("lexy-font")) {
      const link = document.createElement("link");
      link.id = "lexy-font";
      link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap";
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
  }, []);

  useEffect(() => {
    if (currentScene >= SCENE_DURATIONS.length - 1) return;
    const timer = setTimeout(() => setCurrentScene((p) => p + 1), SCENE_DURATIONS[currentScene]);
    return () => clearTimeout(timer);
  }, [currentScene]);

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(videoRef.current.muted);
    }
  };

  return (
    // Outer: fills whatever container the parent gives (the 16:9 card div)
    <div
      ref={containerRef}
      className="w-full h-full overflow-hidden"
      style={{ backgroundColor: colors.bg, fontFamily: '"Inter", sans-serif', position: "relative" }}
    >
      {/* Inner canvas: always 1280×720, pinned top-left, scaled down to fit */}
      <div
        style={{
          width: DESIGN_W,
          height: DESIGN_H,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "absolute",
          top: 0,
          left: 0,
        }}
      >
        <BackgroundLayer currentScene={currentScene} />
        <HeroImageLayer currentScene={currentScene} videoRef={videoRef} />
        <ForegroundLayer currentScene={currentScene} />
        <TransitionLayer currentScene={currentScene} />

        <button
          onClick={toggleMute}
          style={{
            position: "absolute",
            bottom: 20,
            right: 20,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 600,
            background: "rgba(0,229,255,0.12)",
            border: "1px solid rgba(0,229,255,0.4)",
            color: "#00E5FF",
            backdropFilter: "blur(8px)",
            cursor: "pointer",
          }}
        >
          {isMuted ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
              Tap to hear Lexy
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
              Sound on
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function BackgroundLayer({ currentScene }: { currentScene: number }) {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none" }}>
      <motion.div
        style={{ position: "absolute", inset: 0, opacity: 0.4 }}
        animate={{
          background: [
            `radial-gradient(circle at 20% 30%, ${colors.cyan}22 0%, transparent 50%)`,
            `radial-gradient(circle at 80% 70%, ${colors.purple}22 0%, transparent 50%)`,
            `radial-gradient(circle at 50% 50%, ${colors.cyan}11 0%, transparent 60%)`,
          ],
        }}
        transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
      />
      <motion.div
        style={{
          position: "absolute",
          width: 384,
          height: 384,
          borderRadius: "50%",
          filter: "blur(80px)",
          mixBlendMode: "screen",
          backgroundColor: colors.cyan,
          opacity: 0.15,
        }}
        animate={{
          x: currentScene % 2 === 0 ? 128 : 768,
          y: currentScene === 3 ? 144 : -72,
          scale: currentScene === 4 ? 1.5 : 1,
        }}
        transition={{ duration: 4, ease: "easeInOut" }}
      />
      <motion.div
        style={{
          position: "absolute",
          width: 512,
          height: 512,
          borderRadius: "50%",
          filter: "blur(100px)",
          mixBlendMode: "screen",
          backgroundColor: colors.purple,
          opacity: 0.1,
        }}
        animate={{
          x: currentScene === 2 ? 512 : -128,
          y: currentScene === 1 ? 288 : 72,
          scale: currentScene === 4 ? 2 : 1,
        }}
        transition={{ duration: 5, ease: "easeInOut" }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.1,
          backgroundImage: `linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)`,
          backgroundSize: "51px 51px",
        }}
      />
    </div>
  );
}

function HeroImageLayer({ currentScene, videoRef }: { currentScene: number; videoRef: React.RefObject<HTMLVideoElement | null> }) {
  const getVariants = () => {
    switch (currentScene) {
      case 0: return { x: 102, y: 0, scale: 1.05, opacity: 1, filter: "blur(0px)" };
      case 1:
      case 2: return { x: 102, y: 0, scale: 1, opacity: 1, filter: "blur(0px)" };
      case 3: return { x: -410, y: -158, scale: 0.38, opacity: 1, filter: "blur(0px)" };
      case 4:
      default: return { x: -410, y: -158, scale: 0.28, opacity: 0, filter: "blur(10px)" };
    }
  };

  const maskImage = [
    "linear-gradient(to bottom, black 0%, black 72%, transparent 100%)",
    "linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%)",
    "linear-gradient(to bottom, transparent 0%, black 6%, black 100%)",
  ].join(", ");

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <motion.div
        style={{
          position: "relative",
          overflow: "hidden",
          width: 666,
          height: 662,
          transformOrigin: "center center",
          maskImage,
          WebkitMaskImage: maskImage,
          maskComposite: "intersect",
          WebkitMaskComposite: "source-in",
        }}
        initial={false}
        animate={getVariants()}
        transition={{ duration: currentScene === 0 ? 0 : 1.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <motion.video
          ref={videoRef}
          src={lexyVideoSrc}
          autoPlay
          muted
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "contain", objectPosition: "center" }}
          animate={{ scale: currentScene === 3 ? 1.1 : 1 }}
          transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: "30%",
            background: `linear-gradient(to top, ${colors.bg} 50%, transparent 100%)`,
            pointerEvents: "none",
          }}
        />
        <motion.div
          style={{ position: "absolute", inset: 0, border: `1px solid #00E5FF`, borderRadius: currentScene === 3 ? "51px" : 0 }}
          animate={{
            opacity: (currentScene === 1 || currentScene === 2) ? 0.3 : 0,
            scale: (currentScene === 1 || currentScene === 2) ? 1 : 1.05,
          }}
          transition={{ duration: 1, delay: 0.5 }}
        />
      </motion.div>
    </div>
  );
}

function ForegroundLayer({ currentScene }: { currentScene: number }) {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 20, pointerEvents: "none" }}>
      <AnimatePresence mode="wait">
        {currentScene === 0 && <Scene0 key="s0" />}
        {currentScene === 1 && <Scene1 key="s1" />}
        {currentScene === 2 && <Scene2 key="s2" />}
        {currentScene === 3 && <Scene3 key="s3" />}
        {currentScene === 4 && <Scene4 key="s4" />}
      </AnimatePresence>
    </div>
  );
}

function Scene0() {
  return (
    <motion.div
      style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.1, filter: "blur(10px)" }}
      transition={{ duration: 1.2 }}
    >
      <motion.div
        initial={{ opacity: 0, y: 50, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 1.5, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
        style={{ display: "flex", flexDirection: "column", alignItems: "center" }}
      >
        <img src={lexyLogo} alt="Lexy Logo" style={{ width: 192, marginBottom: 32, objectFit: "contain", filter: "drop-shadow(0 0 15px rgba(0,229,255,0.5))" }} />
        <motion.div
          style={{ height: 1, background: "linear-gradient(to right, transparent, #00E5FF, transparent)", width: 256 }}
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={{ duration: 1.5, delay: 1 }}
        />
      </motion.div>
    </motion.div>
  );
}

function Scene1() {
  return (
    <motion.div
      style={{ position: "absolute", inset: 0, padding: "0 0 0 102px", display: "flex", flexDirection: "column", justifyContent: "center" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, x: -50 }}
      transition={{ duration: 0.8 }}
    >
      <div style={{ width: 640 }}>
        <div style={{ overflow: "hidden" }}>
          <motion.h1
            style={{ fontSize: 77, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.03em", color: "#fff", margin: 0, perspective: 1000 }}
            initial={{ y: "100%", rotateX: -45, opacity: 0 }}
            animate={{ y: 0, rotateX: 0, opacity: 1 }}
            transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
          >
            Meet Lexy.
          </motion.h1>
        </div>
        <div style={{ overflow: "hidden", marginTop: 16 }}>
          <motion.h2
            style={{ fontSize: 38, fontWeight: 500, color: "#c084fc", margin: 0 }}
            initial={{ y: "100%", opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.4 }}
          >
            Your Personal Career Advisor.
          </motion.h2>
        </div>
        <motion.div
          style={{ marginTop: 36, width: 51, height: 4, backgroundColor: "#00E5FF" }}
          initial={{ scaleX: 0, originX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.8, delay: 0.8, ease: "circOut" }}
        />
      </div>
    </motion.div>
  );
}

function Scene2() {
  const callouts = [
    { text: "Finds roles that fit your goals", y: 144, x: 128, delay: 0.2 },
    { text: "Interviews you on your schedule", y: 324, x: 192, delay: 0.6 },
    { text: "Gets you in front of great companies", y: 504, x: 154, delay: 1.0 },
  ];

  return (
    <motion.div
      style={{ position: "absolute", inset: 0 }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, filter: "blur(10px)" }}
      transition={{ duration: 0.8 }}
    >
      {callouts.map((c, i) => (
        <motion.div
          key={i}
          style={{ position: "absolute", display: "flex", alignItems: "center", gap: 16, top: c.y, left: c.x }}
          initial={{ opacity: 0, x: -50, scale: 0.9 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 400, damping: 30, delay: c.delay }}
        >
          <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: 38, height: 38, flexShrink: 0 }}>
            <motion.div
              style={{ position: "absolute", inset: 0, border: "1px solid #00E5FF", borderRadius: "50%" }}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: c.delay + 0.2, type: "spring" }}
            />
            <motion.div
              style={{ width: 13, height: 13, backgroundColor: "#00E5FF", borderRadius: "50%" }}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: c.delay + 0.3, type: "spring" }}
            />
          </div>
          <motion.div
            style={{ padding: "12px 26px", background: "rgba(255,255,255,0.05)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12 }}
            initial={{ opacity: 0, clipPath: "inset(0% 100% 0% 0%)" }}
            animate={{ opacity: 1, clipPath: "inset(0% 0% 0% 0%)" }}
            transition={{ delay: c.delay + 0.1, duration: 0.8, ease: "circOut" }}
          >
            <span style={{ fontSize: 26, fontWeight: 500, color: "#fff", letterSpacing: "0.02em" }}>{c.text}</span>
          </motion.div>
        </motion.div>
      ))}
    </motion.div>
  );
}

function Scene3() {
  return (
    <motion.div
      style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", padding: "0 128px" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.05 }}
      transition={{ duration: 1 }}
    >
      <div style={{ width: "80%", marginLeft: "auto", marginTop: 72 }}>
        <motion.p
          style={{ fontSize: 64, lineHeight: 1.1, fontWeight: 600, color: "#fff", letterSpacing: "-0.02em", margin: 0 }}
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1], delay: 0.3 }}
        >
          You deserve more than<br />
          <span style={{ color: "#00E5FF" }}>sending CVs</span> into<br />
          <span style={{ color: "#c084fc" }}>the void.</span>
        </motion.p>
        <motion.div
          style={{ marginTop: 36, display: "inline-block", padding: "8px 26px", border: "1px solid rgba(0,229,255,0.3)", borderRadius: 999, background: "rgba(0,229,255,0.1)", backdropFilter: "blur(8px)" }}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.9, type: "spring" }}
        >
          <span style={{ fontSize: 26, color: "#00E5FF", textTransform: "uppercase", letterSpacing: "0.2em", fontWeight: 700 }}>Let's change that.</span>
        </motion.div>
      </div>
    </motion.div>
  );
}

function Scene4() {
  return (
    <motion.div
      style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1 }}
    >
      <motion.div
        style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center" }}
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
      >
        <motion.div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%,-50%)",
            width: 384,
            height: 384,
            borderRadius: "50%",
            mixBlendMode: "screen",
            background: `radial-gradient(circle, ${colors.cyan}40 0%, transparent 70%)`,
            pointerEvents: "none",
          }}
          animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0.8, 0.5] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        />
        <img src={lexyLogo} alt="Lexy" style={{ width: 256, position: "relative", zIndex: 10 }} />
        <motion.p
          style={{ marginTop: 48, fontSize: 23, color: "rgba(255,255,255,0.7)", letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 500, position: "relative", zIndex: 10 }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 1 }}
        >
          The Intelligence Layer for Human Potential
        </motion.p>
      </motion.div>
    </motion.div>
  );
}

function TransitionLayer({ currentScene }: { currentScene: number }) {
  const [wiping, setWiping] = useState(false);

  useEffect(() => {
    if (currentScene > 0) {
      setWiping(true);
      const t = setTimeout(() => setWiping(false), 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [currentScene]);

  if (!wiping) return null;

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 15, pointerEvents: "none", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <motion.div
        style={{ width: 128, height: 128, borderRadius: "50%", backgroundColor: colors.bg, boxShadow: `0 0 100px 50px ${colors.cyan}33` }}
        initial={{ scale: 0, opacity: 1 }}
        animate={{ scale: 30, opacity: 0 }}
        transition={{ duration: 1.2, ease: [0.64, 0, 0.78, 0] }}
      />
    </div>
  );
}
