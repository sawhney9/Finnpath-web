// ── NEWSLETTER SETUP ──
// To connect Beehiiv:
// 1. Log into beehiiv.com → Settings → Integrations → Subscribe URL
// 2. Copy your URL (looks like: https://your-pub.beehiiv.com/subscribe)
// 3. Replace the placeholder below with your real URL
// 4. Done — all forms on the site will automatically work
const BEEHIIV_SUBSCRIBE_URL =
  window.FINNPATH_BEEHIIV_SUBSCRIBE_URL ||
  "https://YOUR_PUBLICATION.beehiiv.com/subscribe";

function isBeehiivConfigured() {
  return (
    typeof BEEHIIV_SUBSCRIBE_URL === "string" &&
    BEEHIIV_SUBSCRIBE_URL.includes("beehiiv.com") &&
    !BEEHIIV_SUBSCRIBE_URL.includes("YOUR_PUBLICATION")
  );
}

function setFeedback(form, message, isError) {
  const feedback = form.parentElement.querySelector("[data-newsletter-feedback]");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.style.color = isError ? "#e8604c" : "rgba(250,249,247,.75)";
}

function wireNewsletterForm(form) {
  const emailInput = form.querySelector('input[type="email"]');
  if (!emailInput) return;

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    const email = emailInput.value.trim();
    if (!email || !emailInput.checkValidity()) {
      setFeedback(form, "Please enter a valid email address.", true);
      emailInput.focus();
      return;
    }

    if (!isBeehiivConfigured()) {
      setFeedback(
        form,
        "Newsletter is almost ready. Add your Beehiiv URL in newsletter.js.",
        true
      );
      return;
    }

    const subscribeUrl = new URL(BEEHIIV_SUBSCRIBE_URL);
    subscribeUrl.searchParams.set("email", email);
    subscribeUrl.searchParams.set("utm_source", "finnpath.com");
    subscribeUrl.searchParams.set("utm_medium", "website");

    window.open(subscribeUrl.toString(), "_blank", "noopener,noreferrer");
    setFeedback(
      form,
      "Almost done. Confirm your subscription in the Beehiiv tab we opened.",
      false
    );
    form.reset();
  });
}

document.querySelectorAll("[data-newsletter-form]").forEach(wireNewsletterForm);
