import "./index.css"
import { Title, Meta, Link } from "@solidjs/meta"
import { createSignal, Show, For } from "solid-js"
import { Header } from "~/component/header"
import { Footer } from "~/component/footer"
import { Legal } from "~/component/legal"
import { Faq } from "~/component/faq"
import { useI18n } from "~/context/i18n"
import { LocaleLinks } from "~/component/locale-links"

export default function Enterprise() {
  const i18n = useI18n()
  const [formData, setFormData] = createSignal({
    name: "",
    role: "",
    company: "",
    email: "",
    phone: "",
    alias: "",
    message: "",
  })
  const [isSubmitting, setIsSubmitting] = createSignal(false)
  const [showSuccess, setShowSuccess] = createSignal(false)
  const [error, setError] = createSignal("")

  const handleInputChange = (field: string) => (e: Event) => {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement
    setFormData((prev) => ({ ...prev, [field]: target.value }))
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    setError("")
    setShowSuccess(false)
    setIsSubmitting(true)

    try {
      const response = await fetch("/api/enterprise", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(formData()),
      })

      if (response.ok) {
        setShowSuccess(true)
        setFormData({
          name: "",
          role: "",
          company: "",
          email: "",
          phone: "",
          alias: "",
          message: "",
        })
        setTimeout(() => setShowSuccess(false), 5000)
        return
      }

      const data = (await response.json().catch(() => null)) as { error?: string } | null
      setError(data?.error ?? i18n.t("enterprise.form.error.internalServer"))
    } catch (error) {
      console.error("Failed to submit form:", error)
      setError(i18n.t("enterprise.form.error.internalServer"))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main data-page="enterprise">
      <Title>{i18n.t("enterprise.title")}</Title>
      <LocaleLinks path="/enterprise" />
      <Meta name="description" content={i18n.t("enterprise.meta.description")} />
      <Meta property="og:title" content={i18n.t("enterprise.title")} />
      <Meta property="og:description" content={i18n.t("enterprise.meta.description")} />
      <Meta property="og:type" content="website" />
      <Meta property="og:url" content="https://opencode.ai/enterprise" />
      <Meta name="twitter:card" content="summary_large_image" />
      <Meta name="twitter:title" content={i18n.t("enterprise.title")} />
      <Meta name="twitter:description" content={i18n.t("enterprise.meta.description")} />
      <script type="application/ld+json">{JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "OpenCode Enterprise",
        "description": i18n.t("enterprise.meta.description"),
        "url": "https://opencode.ai/enterprise",
        "brand": { "@type": "Organization", "name": "Anomaly", "url": "https://opencode.ai" },
        "offers": { "@type": "Offer", "priceCurrency": "USD", "availability": "https://schema.org/InStock" }
      })}</script>
      <div data-component="container">
        <Header />

        <div data-component="content">
          <section data-component="enterprise-content">
            <div data-component="enterprise-columns">
              <div data-component="enterprise-column-1">
                <h1>{i18n.t("enterprise.hero.title")}</h1>
                <p>{i18n.t("enterprise.hero.body1")}</p>
                <p>{i18n.t("enterprise.hero.body2")}</p>

                <div data-component="trust-signals">
                  <For each={[
                    "enterprise.hero.trust1",
                    "enterprise.hero.trust2",
                    "enterprise.hero.trust3",
                    "enterprise.hero.trust4",
                    "enterprise.hero.trust5",
                    "enterprise.hero.trust6",
                  ] as const}>
                    {(key) => (
                      <div data-component="trust-item">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M3 8L6.5 11.5L13 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                        <span>{i18n.t(key)}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              <div data-component="enterprise-column-2">
                <div data-component="enterprise-form">
                  <form onSubmit={handleSubmit}>
                    <div class="sr-only" aria-hidden="true">
                      <input
                        type="text"
                        name="alias"
                        tabIndex={-1}
                        autocomplete="new-password"
                        inputmode="none"
                        spellcheck={false}
                        value={formData().alias}
                        onInput={handleInputChange("alias")}
                      />
                    </div>

                    <div data-component="form-group">
                      <label for="name">{i18n.t("enterprise.form.name.label")}</label>
                      <input
                        id="name"
                        type="text"
                        required
                        value={formData().name}
                        onInput={handleInputChange("name")}
                        placeholder={i18n.t("enterprise.form.name.placeholder")}
                      />
                    </div>

                    <div data-component="form-group">
                      <label for="role">{i18n.t("enterprise.form.role.label")}</label>
                      <input
                        id="role"
                        type="text"
                        required
                        value={formData().role}
                        onInput={handleInputChange("role")}
                        placeholder={i18n.t("enterprise.form.role.placeholder")}
                      />
                    </div>

                    <div data-component="form-group">
                      <label for="company">{i18n.t("enterprise.form.company.label")}</label>
                      <input
                        id="company"
                        type="text"
                        value={formData().company}
                        onInput={handleInputChange("company")}
                        placeholder={i18n.t("enterprise.form.company.placeholder")}
                      />
                    </div>

                    <div data-component="form-group">
                      <label for="email">{i18n.t("enterprise.form.email.label")}</label>
                      <input
                        id="email"
                        type="email"
                        required
                        value={formData().email}
                        onInput={handleInputChange("email")}
                        placeholder={i18n.t("enterprise.form.email.placeholder")}
                      />
                    </div>

                    <div data-component="form-group">
                      <label for="phone">{i18n.t("enterprise.form.phone.label")}</label>
                      <input
                        id="phone"
                        type="tel"
                        value={formData().phone}
                        onInput={handleInputChange("phone")}
                        placeholder={i18n.t("enterprise.form.phone.placeholder")}
                      />
                    </div>

                    <div data-component="form-group">
                      <label for="message">{i18n.t("enterprise.form.message.label")}</label>
                      <textarea
                        id="message"
                        required
                        rows={5}
                        value={formData().message}
                        onInput={handleInputChange("message")}
                        placeholder={i18n.t("enterprise.form.message.placeholder")}
                      />
                    </div>

                    <button type="submit" disabled={isSubmitting()} data-component="submit-button">
                      {isSubmitting() ? i18n.t("enterprise.form.sending") : i18n.t("enterprise.form.send")}
                    </button>
                  </form>

                  {showSuccess() && <div data-component="success-message">{i18n.t("enterprise.form.success")}</div>}
                  {error() && <div data-component="error-message">{error()}</div>}
                </div>
              </div>
            </div>
          </section>

          <section data-component="faq">
            <div data-slot="section-title">
              <h3>{i18n.t("enterprise.faq.title")}</h3>
            </div>
            <ul>
              <li>
                <Faq question={i18n.t("enterprise.faq.q1")}>{i18n.t("enterprise.faq.a1")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("enterprise.faq.q2")}>{i18n.t("enterprise.faq.a2")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("enterprise.faq.q3")}>{i18n.t("enterprise.faq.a3")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("enterprise.faq.q4")}>{i18n.t("enterprise.faq.a4")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("enterprise.faq.q5")}>
                  {i18n.t("enterprise.faq.a5.before")} <a href="https://trust.opencode.ai">trust.opencode.ai</a>{" "}
                  {i18n.t("enterprise.faq.a5.after")}
                </Faq>
              </li>
            </ul>
          </section>
        </div>
        <Footer />
      </div>
      <Legal />
    </main>
  )
}
