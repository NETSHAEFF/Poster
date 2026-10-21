// ================= GLOBAL STATE =================
let token = localStorage.getItem('web_token') || null;
let currentUser = null;
let currentLang = localStorage.getItem('web_lang') || 'ru';
let allCategories = [];
let allTariffs = [];
let shopSettings = {};
let activeCategoryId = null;

// Telegram Bot Link
let TG_BOT_URL = 'https://t.me/detishop1_bot';

// ================= TOAST NOTIFICATIONS =================
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const icons = {
    success: 'bx bx-check-circle',
    error: 'bx bx-x-circle',
    info: 'bx bx-info-circle',
    warning: 'bx bx-error'
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i class="${icons[type] || icons.info} toast-icon"></i>
    <span class="toast-text">${message}</span>
    <i class="bx bx-x toast-close"></i>
  `;

  const dismiss = () => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 350);
  };

  toast.addEventListener('click', dismiss);
  container.appendChild(toast);
  setTimeout(dismiss, duration);
}

// Checkout State
let selectedTariff = null;
let selectedMethod = null;
let currentOrderId = null;
let selectedFile = null;
let selectedFileBase64 = null;

// Translation Dictionary
const clientTranslations = {
  ru: {
    login_btn: "Войти",
    register_btn: "Регистрация",
    dropdown_profile: "Кабинет",
    dropdown_logout: "Выйти",
    hero_browse: "Смотреть тарифы",
    dashboard_title: "Личный кабинет",
    sub_info_heading: "Статус подписки",
    orders_history_heading: "История транзакций",
    col_order_id: "ID Заказа",
    col_amount: "Сумма",
    col_method: "Метод",
    col_status: "Статус",
    col_date: "Дата",
    no_orders: "Заказов пока нет",
    catalog_title: "Доступные тарифы",
    catalog_subtitle: "Выберите тарифный план. Оплата производится в рублях.",
    input_username: "Имя пользователя",
    input_password: "Пароль",
    select_method_title: "Выберите способ оплаты:",
    no_subscription: "У вас пока нет активной подписки. Выберите подходящий тариф ниже.",
    active_until: "Действует до:",
    days_left: "дн. осталось",
    discount_expiry: "Скидка закончится через",
    btn_pay_ym: "Оплатить ЮМани",
    btn_pay_cb: "Оплатить CryptoBot",
    btn_purchase: "Приобрести",
    btn_checkout_next: "Продолжить оплату",
    btn_i_paid: "Я оплатил, отправить чек",
    receipt_uploaded_success: "Ваш чек успешно отправлен администратору на проверку. Вы получите уведомление после подтверждения!",
    receipt_upload_error: "Произошла ошибка при загрузке чека. Пожалуйста, попробуйте снова.",
    select_file_prompt: "Пожалуйста, выберите файл чека.",
    checking_payment: "Проверка платежа…",
    payment_verified: "Оплата успешно подтверждена! Ваша подписка обновлена.",
    payment_not_verified: "Оплата пока не найдена. Если вы только что оплатили, подождите минуту и попробуйте снова.",
    order_number_label: "Номер заказа:"
  },
  en: {
    login_btn: "Log In",
    register_btn: "Register",
    dropdown_profile: "Dashboard",
    dropdown_logout: "Log Out",
    hero_browse: "Browse Tariffs",
    dashboard_title: "Personal Dashboard",
    sub_info_heading: "Subscription Status",
    orders_history_heading: "Transaction History",
    col_order_id: "Order ID",
    col_amount: "Amount",
    col_method: "Method",
    col_status: "Status",
    col_date: "Date",
    no_orders: "No orders yet",
    catalog_title: "Available Tariffs",
    catalog_subtitle: "Select a tariff plan. Payments are processed in RUB.",
    input_username: "Username",
    input_password: "Password",
    select_method_title: "Select payment method:",
    no_subscription: "You don't have an active subscription. Choose a suitable plan below.",
    active_until: "Valid until:",
    days_left: "days left",
    discount_expiry: "Discount ends in",
    btn_pay_ym: "Pay with YooMoney",
    btn_pay_cb: "Pay with CryptoBot",
    btn_purchase: "Purchase",
    btn_checkout_next: "Proceed to Payment",
    btn_i_paid: "I Paid, Send Receipt",
    receipt_uploaded_success: "Your receipt has been successfully sent to the administrator for verification. You will be notified immediately upon approval!",
    receipt_upload_error: "An error occurred while uploading the receipt. Please try again.",
    select_file_prompt: "Please select a receipt file.",
    checking_payment: "Verifying payment…",
    payment_verified: "Payment successfully verified! Your subscription has been updated.",
    payment_not_verified: "Payment not found yet. If you just paid, please wait a minute and try again.",
    order_number_label: "Order Number:"
  }
};

// ================= API CALL HELPER =================
async function apiCall(endpoint, method = 'GET', body = null) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(endpoint, options);
  
  if (response.status === 401) {
    logout();
    throw new Error('Сессия истекла. Пожалуйста, войдите снова.');
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Ошибка сервера: ${response.status}`);
  }

  return response.json();
}

// ================= INITIALIZATION =================
document.addEventListener('DOMContentLoaded', async () => {
  setupLanguage();
  setupTelegramLinks();
  initParticles();
  setupEventListeners();
  await loadShopData();
  await checkAuth();
  trackSiteVisit();
});

// ================= PARTICLES =================
function initParticles() {
  const canvas = document.getElementById('particles-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const particles = Array.from({ length: 60 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    r: Math.random() * 1.5 + 0.3,
    speedX: (Math.random() - 0.5) * 0.3,
    speedY: (Math.random() - 0.5) * 0.3,
    opacity: Math.random() * 0.5 + 0.1,
    pulse: Math.random() * Math.PI * 2
  }));

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.pulse += 0.02;
      p.x += p.speedX;
      p.y += p.speedY;
      if (p.x < 0) p.x = canvas.width;
      if (p.x > canvas.width) p.x = 0;
      if (p.y < 0) p.y = canvas.height;
      if (p.y > canvas.height) p.y = 0;
      const alpha = p.opacity * (0.6 + 0.4 * Math.sin(p.pulse));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(139, 92, 246, ${alpha})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
}

// Wire all Telegram buttons to bot URL
function setupTelegramLinks() {
  const tgIds = [
    'nav-tg-btn', 'm-nav-tg-btn', 'hero-tg-btn',
    'faq-tg-btn'
  ];
  tgIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.href = TG_BOT_URL;
  });
}

// Setup Initial Language
function setupLanguage() {
  document.getElementById(`lang-btn-${currentLang}`).classList.add('active');
  translatePage();
}

// Set Active Language
async function changeLang(lang) {
  currentLang = lang;
  localStorage.setItem('web_lang', lang);
  
  document.querySelectorAll('.lang-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`lang-btn-${lang}`).classList.add('active');
  
  translatePage();
  renderTariffs();
  renderCategories();
  
  if (currentUser) {
    try {
      await apiCall('/api/web/profile/language', 'POST', { language: lang });
    } catch (e) {}
  }
}

// Translate Static Page Elements
function translatePage() {
  const dict = clientTranslations[currentLang] || clientTranslations.ru;
  
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) {
      el.innerText = dict[key];
    }
  });

  // Handle hero text greeting / logged in user
  const heroTitle = document.getElementById('greeting-title');
  const heroDesc = document.getElementById('greeting-desc');
  
  if (currentUser) {
    if (heroTitle) {
      heroTitle.innerHTML = currentLang === 'en' 
        ? `Hello, <span class="hero-title-accent">${currentUser.username}</span>!` 
        : `Здравствуйте, <span class="hero-title-accent">${currentUser.username}</span>!`;
    }
    if (heroDesc) {
      heroDesc.innerHTML = currentLang === 'en'
        ? `Welcome back! You can manage your subscription in your dashboard or choose a plan below.`
        : `Рады видеть вас снова! Вы можете управлять подпиской в личном кабинете или выбрать тариф ниже.`;
    }
  } else {
    if (heroTitle) {
      heroTitle.innerHTML = currentLang === 'en'
        ? `Exclusive Content<br><span class="hero-title-accent">Just for You</span>`
        : `Эксклюзивный контент<br><span class="hero-title-accent">только для тебя</span>`;
    }
    if (heroDesc) {
      if (shopSettings) {
        const titleKey = currentLang === 'en' ? 'greeting_text_en' : 'greeting_text_ru';
        if (shopSettings[titleKey]) {
          heroDesc.innerHTML = shopSettings[titleKey];
        }
      } else {
        heroDesc.innerHTML = currentLang === 'en'
          ? `Hundreds of hot photos and videos you won't find anywhere else. Join my private Telegram channel.`
          : `Сотни горячих фото и видео, которые ты не найдёшь больше нигде. Присоединяйся к моему закрытому Telegram-каналу.`;
      }
    }
  }

  // Update dynamic placeholders
  const usernameInput = document.getElementById('auth-username');
  if (usernameInput) {
    usernameInput.placeholder = currentLang === 'en' ? 'Enter username' : 'Введите логин';
  }
  const passwordInput = document.getElementById('auth-password');
  if (passwordInput) {
    passwordInput.placeholder = currentLang === 'en' ? 'Enter password' : 'Введите пароль';
  }

  // Translate new Telegram authentication fields
  const tgCodeLabel = document.getElementById('auth-tg-code-label');
  if (tgCodeLabel) {
    tgCodeLabel.innerText = currentLang === 'en' ? 'Code from Telegram bot (/login)' : 'Код из Telegram-бота (/login)';
  }
  const tgBtnLabel = document.getElementById('auth-tg-btn-label');
  if (tgBtnLabel) {
    tgBtnLabel.innerText = currentLang === 'en' ? 'Verify Code & Log In' : 'Войти по коду';
  }
  const tgBotLink = document.getElementById('auth-tg-bot-link');
  if (tgBotLink) {
    tgBotLink.innerHTML = currentLang === 'en' 
      ? `<i class='bx bx-link-external'></i> Get code in bot` 
      : `<i class='bx bx-link-external'></i> Получить код в боте`;
  }
}

// Check Authentication and load Profile details
async function checkAuth() {
  if (!token) {
    showGuestUI();
    return;
  }
  
  try {
    const profile = await apiCall('/api/web/profile');
    currentUser = profile;
    
    // Set language from profile
    if (profile.language && profile.language !== currentLang) {
      currentLang = profile.language;
      localStorage.setItem('web_lang', currentLang);
      document.querySelectorAll('.lang-btn').forEach(btn => btn.classList.remove('active'));
      document.getElementById(`lang-btn-${currentLang}`).classList.add('active');
      translatePage();
    }
    
    showUserUI(profile);
    await loadOrdersHistory();
  } catch (err) {
    console.error('Ошибка проверки токена:', err.message);
    logout();
  }
}

function showGuestUI() {
  document.getElementById('auth-controls').style.display = 'flex';
  document.getElementById('user-controls').style.display = 'none';
  document.getElementById('dashboard-section').style.display = 'none';
  currentUser = null;
  translatePage();
}

function showUserUI(profile) {
  currentUser = profile;
  translatePage();

  document.getElementById('auth-controls').style.display = 'none';
  document.getElementById('user-controls').style.display = 'block';
  document.getElementById('user-username').innerText = profile.username;
  
  // Dashboard panel
  document.getElementById('dashboard-section').style.display = 'block';
  
  const subStatusBadge = document.getElementById('sub-status-badge');
  const subPlanName = document.getElementById('sub-plan-name');
  const subExpiryDate = document.getElementById('sub-expiry-date');
  const progressContainer = document.getElementById('sub-progress-container');
  
  const now = Date.now();
  const isSubActive = profile.subscription_until > now;
  
  if (isSubActive) {
    subStatusBadge.innerText = currentLang === 'en' ? 'Active' : 'Активна';
    subStatusBadge.className = 'badge active';
    
    subPlanName.innerText = profile.planName || 'Premium';
    
    const expiryDateObj = new Date(profile.subscription_until);
    const dateStr = expiryDateObj.toLocaleDateString(currentLang === 'en' ? 'en-US' : 'ru-RU', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    subExpiryDate.innerHTML = `${clientTranslations[currentLang].active_until} <b>${dateStr}</b>`;
    
    // Calculate progress
    // Assume max subscription was extended. For display progress, let's look at remaining days.
    const diffMs = profile.subscription_until - now;
    const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
    
    document.getElementById('sub-days-left').innerText = `${diffDays} ${clientTranslations[currentLang].days_left}`;
    progressContainer.style.display = 'block';
    
    // Smooth progress representation (e.g. up to 30 days)
    const maxDays = 30; // standard base
    const percent = Math.min(100, Math.round((diffDays / maxDays) * 100));
    document.getElementById('sub-progress-fill').style.width = `${percent}%`;
    document.getElementById('sub-percent').innerText = `${percent}%`;
  } else {
    subStatusBadge.innerText = currentLang === 'en' ? 'No subscription' : 'Нет подписки';
    subStatusBadge.className = 'badge expired';
    subPlanName.innerText = clientTranslations[currentLang].no_subscription;
    subExpiryDate.innerText = '';
    progressContainer.style.display = 'none';
  }
}

// Fetch general catalog, categories, settings
async function loadShopData() {
  try {
    showSkeletons(3);
    const data = await apiCall('/api/web/tariffs');
    allCategories = data.categories;
    allTariffs = data.tariffs;
    shopSettings = data.settings;

    if (data.botUsername) {
      TG_BOT_URL = `https://t.me/${data.botUsername}`;
      setupTelegramLinks();
      const botLink = document.getElementById('auth-tg-bot-link');
      if (botLink) botLink.href = TG_BOT_URL;
    }
    
    translatePage(); // Re-run to handle greeting media/text from settings
    renderCategories();
    renderTariffs();
  } catch (err) {
    console.error('Ошибка загрузки данных магазина:', err.message);
  }
}

// Load transaction history for user
async function loadOrdersHistory() {
  const tbody = document.querySelector('#orders-history-table tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="text-center">${currentLang === 'en' ? 'Loading…' : 'Загрузка…'}</td></tr>`;
  
  try {
    const orders = await apiCall('/api/web/orders');
    tbody.innerHTML = '';
    
    if (orders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center">${clientTranslations[currentLang].no_orders}</td></tr>`;
      return;
    }
    
    orders.forEach(o => {
      const tr = document.createElement('tr');
      const dateStr = new Date(o.created_at).toLocaleDateString();
      const statusClass = `status-badge ${o.status}`;
      
      tr.innerHTML = `
        <td><code>${o.id}</code></td>
        <td><b>${o.amount} ₽</b></td>
        <td><span class="badge">${o.payment_method}</span></td>
        <td><span class="${statusClass}">${o.status}</span></td>
        <td>${dateStr}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Ошибка: ${err.message}</td></tr>`;
  }
}

// ================= RENDER CATALOG & TARIFFS =================

// Show skeleton placeholder cards while tariffs load
function showSkeletons(count = 3) {
  const container = document.getElementById('tariffs-container');
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    container.innerHTML += `
      <div class="skeleton-card">
        <div class="skeleton-media"></div>
        <div class="skeleton-body">
          <div class="skeleton-line w-70"></div>
          <div class="skeleton-line w-50"></div>
          <div class="skeleton-line w-90"></div>
          <div class="skeleton-btn"></div>
        </div>
      </div>`;
  }
}

function renderCategories() {
  const container = document.getElementById('category-tabs-container');
  container.innerHTML = '';
  
  // All button
  const allBtn = document.createElement('button');
  allBtn.className = `category-tab-btn ${activeCategoryId === null ? 'active' : ''}`;
  allBtn.innerText = currentLang === 'en' ? 'All' : 'Все';
  allBtn.onclick = () => filterCategory(null);
  container.appendChild(allBtn);
  
  allCategories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = `category-tab-btn ${activeCategoryId === cat.id ? 'active' : ''}`;
    btn.innerText = currentLang === 'en' ? cat.name_en : cat.name_ru;
    btn.onclick = () => filterCategory(cat.id);
    container.appendChild(btn);
  });
}

function filterCategory(catId) {
  activeCategoryId = catId;
  renderCategories();
  renderTariffs();
}

function renderTariffs() {
  const container = document.getElementById('tariffs-container');
  container.innerHTML = '';
  
  const filtered = activeCategoryId === null 
    ? allTariffs 
    : allTariffs.filter(t => t.category_id === activeCategoryId);
    
  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center text-secondary py-3">${currentLang === 'en' ? 'No tariffs found' : 'В этой категории пока нет тарифов'}</div>`;
    return;
  }
  
  filtered.forEach((t, index) => {
    const isFirst = index === 0;
    // Calc price with discount
    const isDiscountActive = t.discount_value > 0 && (t.discount_type === 'permanent' || (t.discount_type === 'temporary' && t.discount_expiry > Date.now()));
    const finalPrice = isDiscountActive 
      ? Math.round(t.price * (1 - t.discount_value / 100)) 
      : t.price;
      
    const name = currentLang === 'en' ? t.name_en : t.name_ru;
    const desc = currentLang === 'en' ? t.description_en : t.description_ru;
    
    // Media block
    let mediaUrl = t.media;
    if (mediaUrl) {
      mediaUrl = mediaUrl.replace(/\\/g, '/');
      if (mediaUrl.startsWith('data/media/')) {
        mediaUrl = mediaUrl.replace('data/media/', '/media/');
      }
    }
    let mediaHtml = `<div class="tariff-media-fallback"><i class='bx bxs-zap'></i></div>`;
    if (mediaUrl) {
      if (t.media_type === 'photo') {
        mediaHtml = `<img src="${mediaUrl}" alt="${name}" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'100\'><rect width=\'100\' height=\'100\' fill=\'%23222\'/><text x=\'50%\' y=\'50%\' dominant-baseline=\'middle\' text-anchor=\'middle\' fill=\'%23555\' font-size=\'14\'>Media</text></svg>'">`;
      } else if (t.media_type === 'video' || t.media_type === 'animation') {
        mediaHtml = `<video src="${mediaUrl}" autoplay loop muted playsinline style="width: 100%; height: 100%; object-fit: cover;"></video>`;
      }
    }
    
    const card = document.createElement('div');
    card.className = `tariff-card${isFirst ? ' popular' : ''}`;
    card.innerHTML = `
      ${isFirst ? '<div class="popular-badge">Популярный</div>' : ''}
      <div class="tariff-media">
        ${mediaHtml}
        ${isDiscountActive ? `<span class="discount-badge">-${t.discount_value}%</span>` : ''}
      </div>
      <div class="tariff-body">
        <h3 class="tariff-title">${name}</h3>
        <div class="tariff-duration"><i class='bx bx-time-five'></i> ${t.duration_days} ${currentLang === 'en' ? 'days' : 'дней'}</div>
        <p class="tariff-desc">${desc}</p>
        <div class="tariff-footer">
          <div class="price-container">
            ${isDiscountActive ? `<span class="original-price">${t.price} ₽</span>` : ''}
            <span class="effective-price">${finalPrice} ₽</span>
          </div>
          <button class="btn btn-primary" onclick="initiateCheckout(${t.id})"><i class='bx bx-cart'></i> ${clientTranslations[currentLang].btn_purchase}</button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

// ================= USER FLOWS & MODALS =================
function setupEventListeners() {
  // Theme Selector (only Lang toggles for now, can support dark/light)
  document.getElementById('lang-btn-ru').onclick = () => changeLang('ru');
  document.getElementById('lang-btn-en').onclick = () => changeLang('en');
  
  // Profile dropdown trigger
  const dropdownTrigger = document.getElementById('profile-trigger');
  const dropdown = document.getElementById('user-dropdown');
  if (dropdownTrigger) {
    dropdownTrigger.onclick = (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('show');
    };
    
    document.addEventListener('click', () => {
      dropdown.classList.remove('show');
    });
  }

  // Logout button
  document.getElementById('logout-btn').onclick = () => logout();
  
  // Auth navigation actions
  const navLoginBtn = document.getElementById('nav-login-btn');
  if (navLoginBtn) navLoginBtn.onclick = () => openAuthModal('login');
  const navRegisterBtn = document.getElementById('nav-register-btn');
  if (navRegisterBtn) navRegisterBtn.onclick = () => openAuthModal('register');
  const closeAuthModalBtn = document.getElementById('close-auth-modal');
  if (closeAuthModalBtn) closeAuthModalBtn.onclick = () => closeModal('auth-modal');
  
  // Auth Form Submit
  document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const action = document.getElementById('auth-action-type').value;
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-error-message');
    errorEl.textContent = '';

    // ===== Client-side validation for registration =====
    if (action === 'register') {
      const latinOnly = /^[a-zA-Z0-9_\-]+$/.test(username);
      if (!latinOnly) {
        errorEl.textContent = currentLang === 'en'
          ? 'Username must contain only Latin letters, digits, _ or -'
          : 'Логин должен содержать только латинские буквы, цифры, _ или -';
        return;
      }
      if (username.length < 3) {
        errorEl.textContent = currentLang === 'en'
          ? 'Username must be at least 3 characters'
          : 'Логин должен содержать минимум 3 символа';
        return;
      }
      if (password.length < 8) {
        errorEl.textContent = currentLang === 'en'
          ? 'Password must be at least 8 characters'
          : 'Пароль должен содержать минимум 8 символов';
        return;
      }
      // Confirm password check
      const confirmPwd = document.getElementById('auth-confirm-password');
      if (confirmPwd && confirmPwd.value !== password) {
        errorEl.textContent = currentLang === 'en'
          ? 'Passwords do not match'
          : 'Пароли не совпадают';
        return;
      }
    }
    // ===================================================
    
    try {
      const res = await apiCall(`/api/web/${action}`, 'POST', { username, password });
      if (res.token) {
        token = res.token;
        localStorage.setItem('web_token', token);
        closeModal('auth-modal');
        await checkAuth();
        showToast(
          action === 'register'
            ? `Добро пожаловать, ${username}! Аккаунт создан.`
            : `Здравствуйте, ${username}!`,
          'success'
        );
      }
    } catch (err) {
      errorEl.textContent = err.message;
      showToast(err.message, 'error');
    }
  };
  
  // Toggle Login/Register inside Auth Modal
  document.getElementById('auth-toggle-btn').onclick = (e) => {
    e.preventDefault();
    const currentAction = document.getElementById('auth-action-type').value;
    openAuthModal(currentAction === 'login' ? 'register' : 'login');
  };

  // Close Checkout Modal
  document.getElementById('close-checkout-modal').onclick = () => closeModal('checkout-modal');
  
  // Checkout Continue Step 1 -> Step 2
  document.getElementById('checkout-next-btn').onclick = async () => {
    await processOrderCheckout();
  };

  // Step 2 Back btn
  document.getElementById('checkout-back-btn').onclick = () => {
    document.getElementById('checkout-step-1').style.display = 'block';
    document.getElementById('checkout-step-2').style.display = 'none';
  };

  // Drag and Drop File Handlers for receipt upload
  const dropZone = document.getElementById('receipt-drop-zone');
  const fileInput = document.getElementById('receipt-file-input');

  if (dropZone && fileInput) {
    dropZone.onclick = () => fileInput.click();
    
    fileInput.onchange = (e) => {
      if (e.target.files.length > 0) {
        handleFileSelect(e.target.files[0]);
      }
    };

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    ['dragleave', 'dragend'].forEach(type => {
      dropZone.addEventListener(type, () => {
        dropZone.classList.remove('dragover');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleFileSelect(e.dataTransfer.files[0]);
      }
    });
  }

  // Remove uploaded file
  document.getElementById('remove-file-btn').onclick = () => {
    selectedFile = null;
    selectedFileBase64 = null;
    document.getElementById('selected-file-info').style.display = 'none';
    document.getElementById('submit-receipt-btn').disabled = true;
  };

  // Submit Receipt Action
  document.getElementById('submit-receipt-btn').onclick = async () => {
    await submitReceiptFile();
  };

  // Check automated payment button
  document.getElementById('check-payment-btn').onclick = async () => {
    await verifyAutomatedPayment();
  };

  // Telegram login code verification
  const verifyTgCodeBtn = document.getElementById('verify-tg-code-btn');
  if (verifyTgCodeBtn) {
    verifyTgCodeBtn.onclick = async () => {
      const codeInput = document.getElementById('auth-tg-code');
      const code = codeInput ? codeInput.value.trim() : '';
      const errorEl = document.getElementById('auth-error-message');
      if (errorEl) errorEl.textContent = '';
      
      if (!code || code.length !== 6 || isNaN(code)) {
        const warning = currentLang === 'en' 
          ? 'Please enter a valid 6-digit code' 
          : 'Пожалуйста, введите корректный 6-значный код';
        if (errorEl) errorEl.textContent = warning;
        showToast(warning, 'warning');
        return;
      }
      
      verifyTgCodeBtn.disabled = true;
      try {
        const res = await apiCall('/api/web/telegram-auth', 'POST', { code });
        if (res.token) {
          token = res.token;
          localStorage.setItem('web_token', token);
          closeModal('auth-modal');
          if (codeInput) codeInput.value = '';
          await checkAuth();
          showToast(
            currentLang === 'en' 
              ? `Hello, ${res.user.username}! You logged in via Telegram.` 
              : `Здравствуйте, ${res.user.username}! Вы вошли через Telegram.`,
            'success'
          );
        }
      } catch (err) {
        if (errorEl) errorEl.textContent = err.message;
        showToast(err.message, 'error');
      } finally {
        verifyTgCodeBtn.disabled = false;
      }
    };
  }
}

// Open Auth Modal
function openAuthModal(action = 'login') {
  const modal = document.getElementById('auth-modal');
  const title = document.getElementById('auth-modal-title');
  const submitBtn = document.getElementById('auth-submit-btn');
  const toggleLabel = document.getElementById('auth-toggle-label');
  const toggleBtn = document.getElementById('auth-toggle-btn');
  const actionInput = document.getElementById('auth-action-type');
  const usernameHint = document.getElementById('username-hint');
  const passwordHint = document.getElementById('password-hint');
  const tgLabel = document.getElementById('auth-tg-label');
  
  actionInput.value = action;
  document.getElementById('auth-form').reset();
  document.getElementById('auth-error-message').textContent = '';
  
  const isRegister = action === 'register';

  // Show/hide hints and confirm password for registration
  if (usernameHint) usernameHint.style.display = isRegister ? 'block' : 'none';
  if (passwordHint) passwordHint.style.display = isRegister ? 'block' : 'none';
  const confirmGroup = document.getElementById('confirm-password-group');
  const confirmInput = document.getElementById('auth-confirm-password');
  if (confirmGroup) confirmGroup.style.display = isRegister ? 'block' : 'none';
  if (confirmInput) { confirmInput.value = ''; confirmInput.required = isRegister; }

  if (!isRegister) {
    title.innerText = currentLang === 'en' ? 'Sign In' : 'Вход в аккаунт';
    submitBtn.innerText = currentLang === 'en' ? 'Log In' : 'Войти';
    toggleLabel.innerText = currentLang === 'en' ? "Don't have an account?" : "Еще нет аккаунта?";
    toggleBtn.innerText = currentLang === 'en' ? "Sign Up" : "Зарегистрироваться";
    if (tgLabel) tgLabel.innerText = currentLang === 'en' ? 'Login / Register via Telegram' : 'Войти / Зарегистрироваться через Telegram';
  } else {
    title.innerText = currentLang === 'en' ? 'Register Account' : 'Регистрация аккаунта';
    submitBtn.innerText = currentLang === 'en' ? 'Sign Up' : 'Зарегистрироваться';
    toggleLabel.innerText = currentLang === 'en' ? "Already have an account?" : "Уже есть аккаунт?";
    toggleBtn.innerText = currentLang === 'en' ? "Sign In" : "Войти";
    if (tgLabel) tgLabel.innerText = currentLang === 'en' ? 'Register via Telegram' : 'Зарегистрироваться через Telegram';
  }
  
  modal.classList.add('show');
}

function openModal(modalId) {
  document.getElementById(modalId).classList.add('show');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('show');
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem('web_token');
  showGuestUI();
  showToast('Вы вышли из аккаунта', 'info');
}

// Initiate checkout modal for a tariff
async function initiateCheckout(tariffId) {
  const tariff = allTariffs.find(x => x.id === tariffId);
  if (!tariff) return;
  
  selectedTariff = tariff;
  selectedMethod = null;
  currentOrderId = null;
  selectedFile = null;
  selectedFileBase64 = null;

  // Показываем или скрываем поле ввода Telegram для гостей
  const guestFields = document.getElementById('checkout-guest-fields');
  const tgInput = document.getElementById('checkout-telegram');
  if (guestFields) {
    if (!token) {
      guestFields.style.display = 'block';
      if (tgInput) tgInput.value = '';
    } else {
      guestFields.style.display = 'none';
    }
  }
  
  // Renders Summary Details
  const isDiscountActive = tariff.discount_value > 0 && (tariff.discount_type === 'permanent' || (tariff.discount_type === 'temporary' && tariff.discount_expiry > Date.now()));
  const finalPrice = isDiscountActive 
    ? Math.round(tariff.price * (1 - tariff.discount_value / 100)) 
    : tariff.price;
    
  document.getElementById('checkout-tariff-name').innerText = currentLang === 'en' ? tariff.name_en : tariff.name_ru;
  document.getElementById('checkout-tariff-duration').innerText = `${tariff.duration_days} ${currentLang === 'en' ? 'days' : 'дней'}`;
  document.getElementById('checkout-tariff-price').innerText = `${finalPrice} ₽`;
  
  // Set default view details
  document.getElementById('checkout-step-1').style.display = 'block';
  document.getElementById('checkout-step-2').style.display = 'none';
  document.getElementById('checkout-next-btn').disabled = true;
  document.getElementById('selected-file-info').style.display = 'none';
  document.getElementById('submit-receipt-btn').disabled = true;
  document.getElementById('payment-status-message').style.display = 'none';
  
  // Render payment methods options
  await renderPaymentMethodsOptions();
  
  openModal('checkout-modal');
}

// Fetch and render payment options
async function renderPaymentMethodsOptions() {
  const container = document.getElementById('payment-methods-container');
  container.innerHTML = '';
  
  // Auto payment settings
  const ymEnabled = shopSettings.payment_ym_enabled !== '0';
  const cbEnabled = shopSettings.payment_cb_enabled !== '0';
  const ymName = currentLang === 'en' ? (shopSettings.btn_name_ym_en || 'YooMoney') : (shopSettings.btn_name_ym_ru || 'ЮМани');
  const cbName = currentLang === 'en' ? (shopSettings.btn_name_cb_en || 'CryptoBot') : (shopSettings.btn_name_cb_ru || 'CryptoBot');
  
  if (ymEnabled) {
    const item = createPaymentMethodItem('yoomoney', ymName, 'bx bxs-credit-card');
    container.appendChild(item);
  }
  
  if (cbEnabled) {
    const item = createPaymentMethodItem('cryptobot', cbName, 'bx bx-bitcoin');
    container.appendChild(item);
  }
  
  // Manual payment options
  try {
    const manualMethods = await apiCall('/api/web/manual-methods');
    manualMethods.forEach(m => {
      const name = currentLang === 'en' ? (m.name_en || m.name_ru) : m.name_ru;
      const item = createPaymentMethodItem(`Ручной: ${m.name_ru}`, name, 'bx bxs-bank');
      container.appendChild(item);
    });
  } catch (e) {
    console.error(e);
  }
}

function createPaymentMethodItem(id, name, iconClass) {
  const div = document.createElement('div');
  div.className = 'payment-method-item';
  div.innerHTML = `
    <div class="method-icon-box"><i class='${iconClass}'></i></div>
    <span class="method-name">${name}</span>
  `;
  
  div.onclick = () => {
    document.querySelectorAll('.payment-method-item').forEach(el => el.classList.remove('selected'));
    div.classList.add('selected');
    selectedMethod = id;
    document.getElementById('checkout-next-btn').disabled = false;
  };
  
  return div;
}

// Process Step 1 Checkout order creation
async function processOrderCheckout() {
  if (!selectedTariff || !selectedMethod) return;
  
  const nextBtn = document.getElementById('checkout-next-btn');
  nextBtn.disabled = true;
  
  let telegramUsername = null;
  if (!token) {
    const tgInput = document.getElementById('checkout-telegram');
    telegramUsername = tgInput ? tgInput.value.trim() : '';
    if (!telegramUsername) {
      showToast(currentLang === 'en' ? 'Please enter your Telegram Username' : 'Пожалуйста, введите ваш Telegram Username', 'warning');
      nextBtn.disabled = false;
      return;
    }
  }
  
  try {
    let orderData;
    if (token) {
      orderData = await apiCall('/api/web/orders', 'POST', {
        tariffId: selectedTariff.id,
        paymentMethod: selectedMethod
      });
    } else {
      orderData = await apiCall('/api/web/orders/guest', 'POST', {
        tariffId: selectedTariff.id,
        paymentMethod: selectedMethod,
        telegramUsername: telegramUsername
      });
    }
    
    currentOrderId = orderData.orderId;
    const paymentOrderIdEl = document.getElementById('payment-order-id');
    if (paymentOrderIdEl) {
      paymentOrderIdEl.innerText = orderData.orderId;
    }
    
    // Fake Loading Sequence
    document.getElementById('checkout-step-1').style.display = 'none';
    const loadingStep = document.getElementById('checkout-step-loading');
    const loadingText = document.getElementById('loading-status-text');
    
    loadingStep.style.display = 'block';
    
    // Step 1: Создание заказа...
    loadingText.innerText = currentLang === 'en' ? 'Creating order...' : 'Создание заказа...';
    await new Promise(r => setTimeout(r, 800));
    
    // Step 2: Генерация номера заказа...
    loadingText.innerText = currentLang === 'en' ? 'Generating order number...' : 'Генерация номера заказа...';
    await new Promise(r => setTimeout(r, 800));
    
    // Step 3: Поиск реквизитов...
    loadingText.innerText = currentLang === 'en' ? 'Searching for payment details...' : 'Поиск реквизитов...';
    await new Promise(r => setTimeout(r, 1000));
    
    loadingStep.style.display = 'none';
    
    // Open Step 2 view
    document.getElementById('checkout-step-2').style.display = 'block';
    
    const instrName = document.getElementById('payment-instruction-name');
    const instrDetails = document.getElementById('payment-instruction-details');
    const instrMedia = document.getElementById('payment-instruction-media');
    
    // Auto Payment setup
    if (selectedMethod === 'yoomoney' || selectedMethod === 'cryptobot') {
      document.getElementById('auto-payment-actions').style.display = 'block';
      document.getElementById('manual-payment-actions').style.display = 'none';
      
      const providerName = selectedMethod === 'yoomoney' ? 'YooMoney' : 'CryptoBot';
      instrName.innerText = `${currentLang === 'en' ? 'Online Payment via' : 'Онлайн оплата через'} ${providerName}`;
      instrDetails.innerText = currentLang === 'en'
        ? 'Click the pay link below to make a payment. Once completed, return here and check verification.'
        : 'Нажмите на кнопку оплаты ниже для совершения платежа. После завершения вернитесь на эту страницу и нажмите "Проверить оплату".';
      
      document.getElementById('pay-link-btn').href = orderData.payUrl;
      instrMedia.style.display = 'none';
    } 
    // Manual Payment setup
    else {
      document.getElementById('auto-payment-actions').style.display = 'none';
      document.getElementById('manual-payment-actions').style.display = 'block';
      
      const instr = orderData.instruction;
      instrName.innerText = currentLang === 'en' ? (instr.name_en || instr.name_ru) : instr.name_ru;
      instrDetails.innerHTML = instr.details;
      
      if (instr.media && instr.media_type === 'photo') {
        instrMedia.innerHTML = `<img src="${instr.media}" alt="QR code" />`;
        instrMedia.style.display = 'block';
      } else {
        instrMedia.style.display = 'none';
      }
    }
  } catch (err) {
    showToast(`Ошибка оформления заказа: ${err.message}`, 'error');
  } finally {
    nextBtn.disabled = false;
  }
}

// Handle Manual file selection & Base64 parsing
function handleFileSelect(file) {
  selectedFile = file;
  document.getElementById('selected-file-name').innerText = file.name;
  document.getElementById('selected-file-info').style.display = 'flex';
  
  const reader = new FileReader();
  reader.onload = function(e) {
    selectedFileBase64 = e.target.result;
    document.getElementById('submit-receipt-btn').disabled = false;
  };
  reader.readAsDataURL(file);
}

// Submit payment receipt upload
async function submitReceiptFile() {
  if (!currentOrderId || !selectedFileBase64) return;
  
  const submitBtn = document.getElementById('submit-receipt-btn');
  submitBtn.disabled = true;
  
  const statusMsg = document.getElementById('payment-status-message');
  statusMsg.style.display = 'none';
  
  try {
    const endpoint = token 
      ? `/api/web/orders/${currentOrderId}/receipt` 
      : `/api/web/orders/${currentOrderId}/receipt-guest`;
      
    await apiCall(endpoint, 'POST', {
      receiptData: selectedFileBase64,
      fileType: selectedFile.type
    });
    
    statusMsg.className = 'info-message success';
    if (token) {
      statusMsg.innerText = clientTranslations[currentLang].receipt_uploaded_success;
    } else {
      const guestTg = document.getElementById('checkout-telegram')?.value || '';
      statusMsg.innerText = currentLang === 'en'
        ? `Receipt sent! The administrator will contact you on Telegram (${guestTg}) to grant your access.`
        : `Чек успешно отправлен! Администратор свяжется с вами в Telegram (${guestTg}) для выдачи доступа.`;
    }
    statusMsg.style.display = 'block';
    
    // Disable form upload again
    submitBtn.style.display = 'none';
    document.getElementById('receipt-drop-zone').style.display = 'none';
    document.getElementById('selected-file-info').style.display = 'none';
    
    // Refresh user details and history
    if (token) {
      await checkAuth();
    }
  } catch (err) {
    statusMsg.className = 'info-message error';
    statusMsg.innerText = `${clientTranslations[currentLang].receipt_upload_error} (${err.message})`;
    statusMsg.style.display = 'block';
    submitBtn.disabled = false;
  }
}

// Verify automated payment
async function verifyAutomatedPayment() {
  if (!currentOrderId) return;
  
  const checkBtn = document.getElementById('check-payment-btn');
  checkBtn.disabled = true;
  
  const statusMsg = document.getElementById('payment-status-message');
  statusMsg.className = 'info-message warning';
  statusMsg.innerText = clientTranslations[currentLang].checking_payment;
  statusMsg.style.display = 'block';
  
  try {
    const res = await apiCall(`/api/web/orders/${currentOrderId}/check`, 'POST');
    
    if (res.success && res.status === 'completed') {
      statusMsg.className = 'info-message success';
      statusMsg.innerText = clientTranslations[currentLang].payment_verified;
      
      // Refresh state
      await checkAuth();
    } else {
      statusMsg.className = 'info-message error';
      statusMsg.innerText = clientTranslations[currentLang].payment_not_verified;
    }
  } catch (err) {
    statusMsg.className = 'info-message error';
    statusMsg.innerText = err.message;
  } finally {
    checkBtn.disabled = false;
  }
}

// Track site visit
async function trackSiteVisit() {
  try {
    await apiCall('/api/web/track-visit', 'POST');
  } catch (err) {
    console.warn('Failed to track site visit:', err);
  }
}
