// Impressum / privacy pages: e-mail and phone links are assembled here, like on the main page,
// so simple scrapers don't find them in the HTML.
document.querySelectorAll('[data-mail]').forEach((a) => {
  const [user, domain] = a.dataset.mail.split('|');
  a.href = `mailto:${user}@${domain}`;
  a.textContent = `${user}@${domain}`;
});
document.querySelectorAll('[data-tel]').forEach((a) => {
  const number = a.dataset.tel.split('|').join(' ');
  a.href = `tel:${number.replace(/[^0-9+]/g, '')}`;
  a.textContent = number;
});
const year = document.getElementById('year');
if (year) year.textContent = String(new Date().getFullYear());
