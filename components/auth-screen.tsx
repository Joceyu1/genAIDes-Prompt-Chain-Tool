"use client";

import { useId, useState, type FormEvent } from "react";
import {
  AlignLeft,
  ArrowDown,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  ImageIcon,
  LoaderCircle,
  LockKeyhole,
  Sparkles,
  Workflow,
} from "lucide-react";

type AuthScreenProps = {
  onAuthenticated: () => void;
  initialError?: string;
};

export function AuthScreen({ onAuthenticated, initialError }: AuthScreenProps) {
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "We couldn’t sign you in. Check your details and try again.",
        );
      }
      onAuthenticated();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to connect. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-story" aria-label="About Chainlab">
        <a className="auth-brand" href="/" aria-label="Chainlab home">
          <span className="auth-brand-icon">
            <Workflow size={22} strokeWidth={1.8} />
          </span>
          <span>
            chain<span className="auth-brand-light">lab</span>
            <span className="auth-brand-dot">.</span>
          </span>
        </a>
        <div className="auth-story-copy">
          <p className="auth-eyebrow">
            <span /> Your next idea, connected
          </p>
          <h1>
            Good ideas.
            <br />
            <em>Great chains.</em>
          </h1>
          <p className="auth-intro">
            Turn a spark of inspiration into something extraordinary. One prompt
            at a time.
          </p>
        </div>
        <div
          className="auth-pipeline"
          aria-label="An image becomes an idea, then a set of captions"
        >
          <div className="auth-input-card">
            <div className="auth-artwork" aria-hidden="true">
              <span className="auth-art-orb" />
              <span className="auth-art-ring ring-one" />
              <span className="auth-art-ring ring-two" />
              <span className="auth-art-shadow" />
              <span className="auth-art-star">✳</span>
            </div>
            <span className="auth-card-caption">
              <ImageIcon size={14} /> A little inspiration
            </span>
          </div>
          <div className="auth-flow-path path-one" aria-hidden="true">
            <ArrowRight size={17} />
          </div>
          <div className="auth-prompt-card auth-prompt-first">
            <div className="auth-prompt-top">
              <span className="auth-mini-icon violet">
                <AlignLeft size={15} />
              </span>
              <span>
                01 <span className="auth-prompt-divider">/</span> Find the story
              </span>
              <Check size={13} className="auth-prompt-check" />
            </div>
            <p>
              Describe what makes this
              <br />
              image a little unexpected.
            </p>
            <div className="auth-model-pill">
              <span /> Text generation
            </div>
          </div>
          <div className="auth-flow-path path-two" aria-hidden="true">
            <ArrowDown size={17} />
          </div>
          <div className="auth-prompt-card auth-prompt-second">
            <div className="auth-prompt-top">
              <span className="auth-mini-icon apricot">
                <Sparkles size={15} />
              </span>
              <span>
                02 <span className="auth-prompt-divider">/</span> Make it
                memorable
              </span>
              <Check size={13} className="auth-prompt-check" />
            </div>
            <p>Now give it five witty captions.</p>
            <div className="auth-output-preview">
              <span>“A fresh perspective.”</span>
              <Sparkles size={13} />
            </div>
          </div>
          <span className="auth-floating-note">
            <span /> Possibilities, multiplied.
          </span>
        </div>
        <div className="auth-story-footer">
          <span className="auth-footer-line" />
          <span>Built for curious minds &amp; creative workflows.</span>
        </div>
      </section>

      <section className="auth-form-side" aria-labelledby="auth-welcome">
        <span className="auth-access-label">
          <LockKeyhole size={13} /> Private workspace
        </span>
        <div className="auth-form-wrap">
          <div className="auth-form-icon">
            <Workflow size={24} strokeWidth={1.6} />
          </div>
          <p className="auth-form-kicker">LET’S MAKE SOMETHING</p>
          <h2 id="auth-welcome">Welcome to your studio.</h2>
          <p className="auth-form-description">
            Sign in to build, connect, and create.
          </p>

          {initialError && !error && (
            <div className="auth-notice" role="status">
              {initialError}
            </div>
          )}
          <form className="auth-form" onSubmit={handleSubmit}>
            <div className="auth-field">
              <label htmlFor={emailId}>Email address</label>
              <input
                id={emailId}
                type="email"
                name="email"
                autoComplete="username"
                placeholder="you@yourstudio.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                disabled={isSubmitting}
              />
            </div>
            <div className="auth-field">
              <label htmlFor={passwordId}>Password</label>
              <div className="auth-password-wrap">
                <input
                  id={passwordId}
                  type={showPassword ? "text" : "password"}
                  name="password"
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  disabled={isSubmitting}
                />
                <button
                  className="auth-password-toggle"
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>
            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="auth-submit"
              type="submit"
              disabled={isSubmitting}
            >
              <span>
                {isSubmitting ? "Signing in…" : "Sign in to Chainlab"}
              </span>
              {isSubmitting ? (
                <LoaderCircle className="auth-spinner" size={18} />
              ) : (
                <ArrowRight size={18} />
              )}
            </button>
          </form>
          <p className="auth-superadmin-note">
            <LockKeyhole size={13} /> Access is limited to superadmins.
          </p>
        </div>
        <p className="auth-form-footer">
          A thoughtful space for your next big idea.
        </p>
      </section>
    </main>
  );
}
