// ── NEWSLETTER SETUP ──
// Beehiiv publication served on the custom domain insights.finnpath.com.
// All subscribe forms on the site post to the URL below.
const BEEHIIV_SUBSCRIBE_URL =
  window.FINNPATH_BEEHIIV_SUBSCRIBE_URL ||
  "https://insights.finnpath.com/subscribe";

function isBeehiivConfigured() {
  return (
    typeof BEEHIIV_SUBSCRIBE_URL === "string" &&
    /^https:\/\//.test(BEEHIIV_SUBSCRIBE_URL) &&
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
