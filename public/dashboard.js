(function () {
    let editingMechanicId = null;
    let mechanicRecords = [];
    let editingBannerId = null;
    let bannerRecords = [];
    let editingWorkId = null;
    let workRecords = [];
    let editingReviewId = null;
    let adminReviewRecords = [];

    function setServiceStatus(elementId, status, message) {
        const element = document.getElementById(elementId);
        element.textContent = message;
        element.className = 'dashboard-service-status status-' + status;
    }

    async function checkGoogleMapsStatus() {
        const response = await fetch('/service.html');
        if (!response.ok) {
            throw new Error('โหลดการตั้งค่า Google Maps ไม่สำเร็จ');
        }

        const servicePage = new DOMParser().parseFromString(await response.text(), 'text/html');
        const apiKey = servicePage.querySelector('meta[name="google-maps-api-key"]')?.content;
        if (!apiKey || apiKey === 'YOUR_API_KEY') {
            setServiceStatus('googleMapsStatus', 'unavailable', 'ยังไม่ได้ตั้งค่า API key');
            return;
        }

        window.dashboardMapsAuthFailed = false;
        await new Promise(function (resolve, reject) {
            let timeout;
            let settled = false;
            const script = document.createElement('script');
            function finish(callback, value) {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeout);
                callback(value);
            }

            window.dashboardMapsReady = function () {
                window.setTimeout(function () {
                    if (window.dashboardMapsAuthFailed) {
                        finish(reject, new Error('Google Maps API key ใช้งานไม่ได้'));
                    } else if (window.google && window.google.maps) {
                        finish(resolve);
                    } else {
                        finish(reject, new Error('Google Maps API โหลดไม่สำเร็จ'));
                    }
                }, 1000);
            };
            window.gm_authFailure = function () {
                window.dashboardMapsAuthFailed = true;
                const error = new Error('Google Maps API key ใช้งานไม่ได้');
                if (settled) {
                    setServiceStatus('googleMapsStatus', 'unavailable', error.message);
                } else {
                    finish(reject, error);
                }
            };
            timeout = window.setTimeout(function () {
                finish(reject, new Error('หมดเวลารอ Google Maps API'));
            }, 10000);
            script.src = 'https://maps.googleapis.com/maps/api/js?key=' +
                encodeURIComponent(apiKey) +
                '&callback=dashboardMapsReady&language=th&region=TH';
            script.async = true;
            script.onerror = function () {
                finish(reject, new Error('เชื่อมต่อ Google Maps API ไม่สำเร็จ'));
            };
            document.head.appendChild(script);
        });

        if (window.dashboardMapsAuthFailed) {
            throw new Error('Google Maps API key ใช้งานไม่ได้');
        }
        setServiceStatus('googleMapsStatus', 'operational', 'ปกติ');
    }

    async function checkOtpStatus() {
        const response = await fetch('/api/admin/dashboard-status');

        if (response.status === 401) {
            window.location.assign('login.html');
            return;
        }
        if (response.status === 403) {
            window.location.assign('home.html');
            return;
        }
        if (!response.ok) {
            throw new Error('ตรวจสอบสถานะ OTP API ไม่สำเร็จ');
        }

        const data = await response.json();
        const statuses = {
            operational: ['operational', 'ปกติ (เชื่อมต่อ Twilio Verify แล้ว)'],
            development: ['warning', 'โหมดทดสอบ (ไม่ได้ส่ง SMS จริง)'],
            not_configured: ['unavailable', 'ยังไม่ได้ตั้งค่า Twilio'],
            unavailable: ['unavailable', 'เชื่อมต่อไม่ได้ กรุณาตรวจสอบการตั้งค่า']
        };
        const status = statuses[data.otp.status] || statuses.unavailable;
        setServiceStatus('otpStatus', status[0], status[1]);
    }

    async function readApiJson(response, failureMessage) {
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.toLowerCase().includes('application/json')) {
            if (response.redirected) {
                throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
            }
            throw new Error('ไม่พบ Dashboard API กรุณาเปิดระบบผ่าน npm start และรีสตาร์ตเซิร์ฟเวอร์');
        }

        const data = await response.json();
        if (!response.ok) throw new Error(data.message || failureMessage);
        return data;
    }

    async function loadDashboard() {
        const response = await fetch('/api/admin/dashboard');

        if (response.status === 401) {
            window.location.assign('login.html');
            return;
        }
        if (response.status === 403) {
            window.location.assign('home.html');
            return;
        }
        if (!response.ok) {
            throw new Error('โหลดข้อมูล Dashboard ไม่สำเร็จ');
        }

        const data = await response.json();
        document.getElementById('registeredUsers').textContent = data.registeredUsers;
        document.getElementById('mechanicCount').textContent = data.mechanicCount;
        document.getElementById('totalReviewCount').textContent = data.totalReviews;
        renderReviewCategoryCounts(data.reviewCategories);

        const checks = [
            loadBanners().catch(function (error) {
                console.error(error);
                document.getElementById('bannerList').textContent = error.message;
            }),
            checkGoogleMapsStatus().catch(function (error) {
                console.error(error);
                setServiceStatus('googleMapsStatus', 'unavailable', error.message);
            }),
            checkOtpStatus().catch(function (error) {
                console.error(error);
                setServiceStatus('otpStatus', 'unavailable', 'ตรวจสอบสถานะไม่สำเร็จ');
            })
        ];
        await Promise.all(checks);
    }

    function renderReviewCategoryCounts(categories) {
        const container = document.getElementById('reviewCategoryCounts');
        if (!Array.isArray(categories)) {
            throw new Error('รูปแบบข้อมูลสรุปรีวิวไม่ถูกต้อง');
        }

        container.replaceChildren();
        categories.forEach(function (category) {
            const item = document.createElement('div');
            item.className = 'review-category-count';
            const label = document.createElement('span');
            label.textContent = category.label;
            const count = document.createElement('strong');
            count.textContent = category.count;
            item.append(label, count);
            container.append(item);
        });
    }

    function renderBanners() {
        const list = document.getElementById('bannerList');
        list.replaceChildren();
        if (!bannerRecords.length) {
            list.textContent = 'ยังไม่มี Banner ในระบบ';
            return;
        }

        bannerRecords.forEach(function (banner) {
            const item = document.createElement('article');
            item.className = 'mechanic-list-item';
            const details = document.createElement('div');
            details.className = 'mechanic-list-details';
            const image = document.createElement('img');
            image.className = 'banner-list-image';
            image.src = banner.image;
            image.alt = banner.altText;
            const text = document.createElement('div');
            const description = document.createElement('strong');
            description.className = 'mechanic-list-name';
            description.textContent = banner.altText || 'ไม่มีคำอธิบาย';
            const path = document.createElement('p');
            path.textContent = banner.image;
            text.append(description, path);
            details.append(image, text);

            const actions = document.createElement('div');
            actions.className = 'mechanic-list-actions';
            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'mechanic-edit-button';
            editButton.textContent = 'แก้ไข';
            editButton.addEventListener('click', function () {
                editBanner(banner);
            });
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'mechanic-delete-button';
            removeButton.textContent = 'ลบ Banner';
            removeButton.addEventListener('click', function () {
                deleteBanner(banner.id, banner.altText || banner.image, removeButton);
            });
            actions.append(editButton, removeButton);
            item.append(details, actions);
            list.append(item);
        });
    }

    async function loadBanners() {
        const response = await fetch('/api/admin/banners');
        if (response.status === 401) {
            window.location.assign('login.html');
            return;
        }
        if (response.status === 403) {
            window.location.assign('home.html');
            return;
        }
        const data = await readApiJson(response, 'โหลดข้อมูล Banner ไม่สำเร็จ');
        bannerRecords = data.banners;
        renderBanners();
    }

    function editBanner(banner) {
        const form = document.getElementById('bannerForm');
        editingBannerId = banner.id;
        form.elements.image.value = banner.image;
        form.elements.altText.value = banner.altText;
        form.querySelector('[type="submit"]').textContent = 'บันทึกการแก้ไข';
        document.getElementById('cancelBannerEdit').hidden = false;
        document.getElementById('bannerStatus').textContent = 'กำลังแก้ไข Banner';
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        form.elements.image.focus({ preventScroll: true });
    }

    function cancelBannerEdit() {
        const form = document.getElementById('bannerForm');
        editingBannerId = null;
        form.reset();
        form.querySelector('[type="submit"]').textContent = 'เพิ่ม Banner';
        document.getElementById('cancelBannerEdit').hidden = true;
        document.getElementById('bannerStatus').textContent = '';
    }

    async function deleteBanner(id, name, button) {
        if (!window.confirm('ยืนยันลบ Banner ' + name + ' หรือไม่?')) return;
        button.disabled = true;
        try {
            const response = await fetch('/api/admin/banners/' + encodeURIComponent(id), { method: 'DELETE' });
            if (response.status === 401) {
                window.location.assign('login.html');
                return;
            }
            if (response.status === 403) {
                window.location.assign('home.html');
                return;
            }
            await readApiJson(response, 'ลบ Banner ไม่สำเร็จ');
            document.getElementById('bannerStatus').textContent = 'ลบ Banner แล้ว';
            await loadBanners();
        } catch (error) {
            console.error(error);
            document.getElementById('bannerStatus').textContent = error.message;
            button.disabled = false;
        }
    }

    function renderWorks() {
        const list = document.getElementById('workList');
        list.replaceChildren();
        if (!workRecords.length) {
            list.textContent = 'ยังไม่มีตัวอย่างผลงานในระบบ';
            return;
        }

        workRecords.forEach(function (work) {
            const item = document.createElement('article');
            item.className = 'mechanic-list-item';

            const details = document.createElement('div');
            details.className = 'dashboard-work-details';
            const images = document.createElement('div');
            images.className = 'dashboard-work-images';
            [
                { src: work.beforeImage, label: 'ก่อน' },
                { src: work.afterImage, label: 'หลัง' }
            ].forEach(function (imageData) {
                const preview = document.createElement('div');
                preview.className = 'dashboard-work-image-wrap';
                const image = document.createElement('img');
                image.className = 'dashboard-work-image';
                image.src = imageData.src;
                image.alt = 'รูป' + imageData.label + 'ซ่อม - ' + work.title;
                const label = document.createElement('span');
                label.textContent = imageData.label;
                preview.append(image, label);
                images.append(preview);
            });
            const title = document.createElement('strong');
            title.className = 'mechanic-list-name';
            title.textContent = work.title;
            details.append(images, title);

            const actions = document.createElement('div');
            actions.className = 'mechanic-list-actions';
            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'mechanic-edit-button';
            editButton.textContent = 'แก้ไข';
            editButton.addEventListener('click', function () {
                editWork(work);
            });
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'mechanic-delete-button';
            removeButton.textContent = 'ลบผลงาน';
            removeButton.addEventListener('click', function () {
                deleteWork(work.id, work.title, removeButton);
            });
            actions.append(editButton, removeButton);
            item.append(details, actions);
            list.append(item);
        });
    }

    async function loadWorks() {
        const response = await fetch('/api/admin/works');
        if (response.status === 401) {
            window.location.assign('login.html');
            return;
        }
        if (response.status === 403) {
            window.location.assign('home.html');
            return;
        }
        const data = await readApiJson(response, 'โหลดตัวอย่างผลงานไม่สำเร็จ');
        workRecords = data.works;
        renderWorks();
    }

    async function refreshReviewOverview() {
        const response = await fetch('/api/admin/dashboard');
        if (response.status === 401) {
            window.location.assign('login.html');
            return;
        }
        if (response.status === 403) {
            window.location.assign('home.html');
            return;
        }
        const data = await readApiJson(response, 'โหลดสรุปรีวิวไม่สำเร็จ');
        document.getElementById('totalReviewCount').textContent = data.totalReviews;
        renderReviewCategoryCounts(data.reviewCategories);
    }

    function renderAdminReviews() {
        const list = document.getElementById('adminReviewList');
        list.replaceChildren();
        if (!adminReviewRecords.length) {
            list.textContent = 'ยังไม่มีรีวิวในระบบ';
            return;
        }

        const categoryLabels = {
            repair: 'ช่างซ่อม',
            tirerepair: 'ช่างปะยาง',
            carwash: 'ล้างภายใน/ภายนอก',
            oilchange: 'ถ่ายน้ำมันเครื่อง',
            battery: 'เปลี่ยนแบต',
            carcheck: 'เช็คสภาพรถ'
        };

        adminReviewRecords.forEach(function (review) {
            const item = document.createElement('article');
            item.className = 'mechanic-list-item';
            const details = document.createElement('div');
            details.className = 'mechanic-list-details dashboard-review-details';
            const profile = document.createElement('img');
            profile.className = 'mechanic-list-photo';
            profile.alt = '';
            profile.src = review.profileImage || 'img/logo.png';
            const text = document.createElement('div');
            text.className = 'dashboard-review-text';
            const name = document.createElement('strong');
            name.className = 'mechanic-list-name';
            name.textContent = review.name;
            const metadata = document.createElement('p');
            metadata.textContent = '★'.repeat(review.rating) + ' · ' +
                (categoryLabels[review.category] || 'ไม่ระบุหมวดหมู่');
            const body = document.createElement('p');
            body.textContent = review.review;
            text.append(name, metadata, body);
            details.append(profile, text);
            if (review.photo) {
                const photo = document.createElement('img');
                photo.className = 'dashboard-review-photo';
                photo.alt = 'ภาพประกอบรีวิว';
                photo.src = review.photo;
                details.append(photo);
            }

            const actions = document.createElement('div');
            actions.className = 'mechanic-list-actions';
            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'mechanic-edit-button';
            editButton.textContent = 'แก้ไข';
            editButton.addEventListener('click', function () {
                editAdminReview(review);
            });
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'mechanic-delete-button';
            deleteButton.textContent = 'ลบรีวิว';
            deleteButton.addEventListener('click', function () {
                deleteAdminReview(review.id, review.name, deleteButton);
            });
            actions.append(editButton, deleteButton);
            item.append(details, actions);
            list.append(item);
        });
    }

    async function loadAdminReviews() {
        const response = await fetch('/api/admin/reviews');
        if (response.status === 401) {
            window.location.assign('login.html');
            return;
        }
        if (response.status === 403) {
            window.location.assign('home.html');
            return;
        }
        const data = await readApiJson(response, 'โหลดรีวิวไม่สำเร็จ');
        adminReviewRecords = data.reviews;
        renderAdminReviews();
    }

    function editAdminReview(review) {
        const form = document.getElementById('adminReviewForm');
        editingReviewId = review.id;
        form.elements.name.value = review.name;
        form.elements.rating.value = String(review.rating);
        form.elements.category.value = review.category || '';
        form.elements.review.value = review.review;
        form.elements.profileImage.value = review.profileImage || '';
        form.elements.photo.value = review.photo || '';
        form.querySelector('[type="submit"]').textContent = 'บันทึกการแก้ไข';
        document.getElementById('cancelReviewEdit').hidden = false;
        document.getElementById('adminReviewStatus').textContent = 'กำลังแก้ไขรีวิวของ ' + review.name;
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        form.elements.name.focus({ preventScroll: true });
    }

    function cancelAdminReviewEdit() {
        const form = document.getElementById('adminReviewForm');
        editingReviewId = null;
        form.reset();
        form.querySelector('[type="submit"]').textContent = 'เพิ่มรีวิว';
        document.getElementById('cancelReviewEdit').hidden = true;
        document.getElementById('adminReviewStatus').textContent = '';
    }

    async function deleteAdminReview(id, name, button) {
        if (!window.confirm('ยืนยันลบรีวิวของ ' + name + ' หรือไม่?')) return;
        button.disabled = true;
        try {
            const response = await fetch('/api/admin/reviews/' + encodeURIComponent(id), { method: 'DELETE' });
            if (response.status === 401) {
                window.location.assign('login.html');
                return;
            }
            if (response.status === 403) {
                window.location.assign('home.html');
                return;
            }
            await readApiJson(response, 'ลบรีวิวไม่สำเร็จ');
            if (editingReviewId === id) cancelAdminReviewEdit();
            document.getElementById('adminReviewStatus').textContent = 'ลบรีวิวแล้ว';
            await Promise.all([loadAdminReviews(), refreshReviewOverview()]);
        } catch (error) {
            console.error(error);
            document.getElementById('adminReviewStatus').textContent = error.message;
            button.disabled = false;
        }
    }

    function editWork(work) {
        const form = document.getElementById('workForm');
        editingWorkId = work.id;
        form.elements.title.value = work.title;
        form.elements.beforeImage.value = work.beforeImage;
        form.elements.afterImage.value = work.afterImage;
        form.querySelector('[type="submit"]').textContent = 'บันทึกการแก้ไข';
        document.getElementById('cancelWorkEdit').hidden = false;
        document.getElementById('workStatus').textContent = 'กำลังแก้ไข ' + work.title;
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        form.elements.title.focus({ preventScroll: true });
    }

    function cancelWorkEdit() {
        const form = document.getElementById('workForm');
        editingWorkId = null;
        form.reset();
        form.querySelector('[type="submit"]').textContent = 'เพิ่มผลงาน';
        document.getElementById('cancelWorkEdit').hidden = true;
        document.getElementById('workStatus').textContent = '';
    }

    async function deleteWork(id, title, button) {
        if (!window.confirm('ยืนยันลบผลงาน "' + title + '" หรือไม่?')) return;
        button.disabled = true;
        try {
            const response = await fetch('/api/admin/works/' + encodeURIComponent(id), { method: 'DELETE' });
            if (response.status === 401) {
                window.location.assign('login.html');
                return;
            }
            if (response.status === 403) {
                window.location.assign('home.html');
                return;
            }
            await readApiJson(response, 'ลบผลงานไม่สำเร็จ');
            if (editingWorkId === id) cancelWorkEdit();
            document.getElementById('workStatus').textContent = 'ลบผลงานแล้ว';
            await loadWorks();
        } catch (error) {
            console.error(error);
            document.getElementById('workStatus').textContent = error.message;
            button.disabled = false;
        }
    }

    function renderMechanics() {
        const list = document.getElementById('mechanicList');
        const searchInput = document.getElementById('mechanicSearch');
        const searchTerm = searchInput.value.trim().toLocaleLowerCase();
        list.replaceChildren();
        if (!mechanicRecords.length) {
            list.textContent = 'ยังไม่มีข้อมูลช่างในระบบ';
        } else {
            const matchingMechanics = mechanicRecords.filter(function (mechanic) {
                return [mechanic.nameEn, mechanic.nameTh]
                    .some(function (name) {
                        return name.toLocaleLowerCase().includes(searchTerm);
                    });
            });
            if (!matchingMechanics.length) {
                list.textContent = 'ไม่พบช่างที่ค้นหา';
            }
            matchingMechanics.forEach(function (mechanic) {
                const item = document.createElement('article');
                item.className = 'mechanic-list-item';

                const details = document.createElement('div');
                details.className = 'mechanic-list-details';
                const photo = document.createElement('img');
                photo.className = 'mechanic-list-photo';
                photo.alt = '';
                photo.src = mechanic.image || 'imgmechanic/error.png';
                photo.addEventListener('error', function () {
                    if (photo.getAttribute('src') !== 'imgmechanic/error.png') {
                        photo.src = 'imgmechanic/error.png';
                    }
                });
                const text = document.createElement('div');
                const name = document.createElement('strong');
                name.className = 'mechanic-list-name';
                name.textContent = mechanic.nameEn + (mechanic.nameTh ? ' · ' + mechanic.nameTh : '');
                const contact = document.createElement('p');
                contact.textContent = [mechanic.phone, mechanic.shopLocation].filter(Boolean).join(' · ') || 'ไม่มีข้อมูลติดต่อ';
                const rating = document.createElement('p');
                const stars = Math.max(0, Math.min(5, Math.ceil(Number(mechanic.rating) || 0)));
                rating.textContent = '★'.repeat(stars) + ' ' + mechanic.rating + ' (' + mechanic.ratingCount + ')';
                text.append(name, contact, rating);
                details.append(photo, text);

                const actions = document.createElement('div');
                actions.className = 'mechanic-list-actions';
                const editButton = document.createElement('button');
                editButton.type = 'button';
                editButton.className = 'mechanic-edit-button';
                editButton.textContent = 'แก้ไข';
                editButton.addEventListener('click', function () {
                    editMechanic(mechanic);
                });
                const removeButton = document.createElement('button');
                removeButton.type = 'button';
                removeButton.className = 'mechanic-delete-button';
                removeButton.textContent = 'ลบช่าง';
                removeButton.addEventListener('click', function () {
                    deleteMechanic(mechanic.id, mechanic.nameEn, removeButton);
                });
                actions.append(editButton, removeButton);
                item.append(details, actions);
                list.append(item);
            });
        }
        document.getElementById('mechanicCount').textContent = mechanicRecords.length;
    }

    async function loadMechanics() {
        const response = await fetch('/api/admin/mechanics');
        if (response.status === 401) {
            window.location.assign('login.html');
            return;
        }
        if (response.status === 403) {
            window.location.assign('home.html');
            return;
        }
        const data = await readApiJson(response, 'โหลดข้อมูลช่างไม่สำเร็จ');
        mechanicRecords = data.mechanics;
        renderMechanics();
    }

    document.getElementById('mechanicSearch').addEventListener('input', function () {
        renderMechanics();
    });

    function editMechanic(mechanic) {
        const form = document.getElementById('mechanicForm');
        editingMechanicId = mechanic.id;
        form.elements.nameEn.value = mechanic.nameEn;
        form.elements.nameTh.value = mechanic.nameTh;
        form.elements.phone.value = mechanic.phone;
        form.elements.lineId.value = mechanic.lineId;
        form.elements.facebook.value = mechanic.facebook;
        form.elements.shopLocation.value = mechanic.shopLocation;
        form.elements.rating.value = mechanic.rating;
        form.elements.ratingCount.value = mechanic.ratingCount;
        form.elements.lat.value = mechanic.lat;
        form.elements.lng.value = mechanic.lng;
        form.elements.image.value = mechanic.image;
        form.querySelectorAll('input[name="categories"]').forEach(function (checkbox) {
            checkbox.checked = mechanic.categories.includes(checkbox.value);
        });
        form.querySelector('input[name="hasShop"][value="' + mechanic.hasShop + '"]').checked = true;
        form.querySelector('[type="submit"]').textContent = 'บันทึกการแก้ไข';
        document.getElementById('cancelMechanicEdit').hidden = false;
        document.getElementById('mechanicStatus').textContent = 'กำลังแก้ไขข้อมูล ' + mechanic.nameEn;
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        form.elements.nameEn.focus({ preventScroll: true });
    }

    function cancelMechanicEdit() {
        const form = document.getElementById('mechanicForm');
        editingMechanicId = null;
        form.reset();
        form.querySelector('[type="submit"]').textContent = 'เพิ่มช่าง';
        document.getElementById('cancelMechanicEdit').hidden = true;
        document.getElementById('mechanicStatus').textContent = '';
    }

    async function deleteMechanic(id, name, button) {
        if (!window.confirm('ยืนยันลบข้อมูลช่าง ' + name + ' หรือไม่?')) return;
        button.disabled = true;
        try {
            const response = await fetch('/api/admin/mechanics/' + encodeURIComponent(id), { method: 'DELETE' });
            if (response.status === 401) {
                window.location.assign('login.html');
                return;
            }
            if (response.status === 403) {
                window.location.assign('home.html');
                return;
            }
            await readApiJson(response, 'ลบข้อมูลช่างไม่สำเร็จ');
            document.getElementById('mechanicStatus').textContent = 'ลบข้อมูลช่างแล้ว';
            await loadMechanics();
        } catch (error) {
            console.error(error);
            document.getElementById('mechanicStatus').textContent = error.message;
            button.disabled = false;
        }
    }

    document.querySelectorAll('.dashboard-nav-link').forEach(function (button) {
        button.addEventListener('click', function () {
            document.querySelectorAll('.dashboard-nav-link').forEach(function (link) {
                link.classList.toggle('active', link === button);
                if (link === button) {
                    link.setAttribute('aria-current', 'page');
                } else {
                    link.removeAttribute('aria-current');
                }
            });
            document.querySelectorAll('.dashboard-panel').forEach(function (panel) {
                panel.hidden = panel.id !== button.dataset.panel;
            });
            if (button.dataset.panel === 'mechanicPanel') {
                loadMechanics().catch(function (error) {
                    console.error(error);
                    document.getElementById('mechanicList').textContent = error.message;
                });
            } else if (button.dataset.panel === 'workPanel') {
                Promise.all([
                    loadWorks().catch(function (error) {
                        console.error(error);
                        document.getElementById('workList').textContent = error.message;
                    }),
                    loadAdminReviews().catch(function (error) {
                        console.error(error);
                        document.getElementById('adminReviewList').textContent = error.message;
                    })
                ]);
            }
        });
    });

    document.getElementById('mechanicForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const form = event.currentTarget;
        const submitButton = form.querySelector('[type="submit"]');
        const formData = new FormData(form);
        const mechanic = {
            nameEn: formData.get('nameEn'),
            nameTh: formData.get('nameTh'),
            phone: formData.get('phone'),
            lineId: formData.get('lineId'),
            facebook: formData.get('facebook'),
            shopLocation: formData.get('shopLocation'),
            rating: formData.get('rating'),
            ratingCount: formData.get('ratingCount'),
            lat: formData.get('lat'),
            lng: formData.get('lng'),
            image: formData.get('image'),
            hasShop: formData.get('hasShop') === 'true',
            categories: formData.getAll('categories')
        };

        submitButton.disabled = true;
        document.getElementById('mechanicStatus').textContent = '';
        try {
            const isEditing = editingMechanicId !== null;
            const endpoint = isEditing
                ? '/api/admin/mechanics/' + encodeURIComponent(editingMechanicId)
                : '/api/admin/mechanics';
            const response = await fetch(endpoint, {
                method: isEditing ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(mechanic)
            });
            if (response.status === 401) {
                window.location.assign('login.html');
                return;
            }
            if (response.status === 403) {
                window.location.assign('home.html');
                return;
            }
            await readApiJson(response, isEditing ? 'แก้ไขข้อมูลช่างไม่สำเร็จ' : 'เพิ่มข้อมูลช่างไม่สำเร็จ');
            const status = document.getElementById('mechanicStatus');
            if (isEditing) {
                cancelMechanicEdit();
                status.textContent = 'แก้ไขข้อมูลช่างแล้ว';
            } else {
                form.reset();
                status.textContent = 'เพิ่มข้อมูลช่างแล้ว';
            }
            await loadMechanics();
        } catch (error) {
            console.error(error);
            document.getElementById('mechanicStatus').textContent = error.message;
        } finally {
            submitButton.disabled = false;
        }
    });

    document.getElementById('cancelMechanicEdit').addEventListener('click', cancelMechanicEdit);

    document.getElementById('bannerForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const form = event.currentTarget;
        const submitButton = form.querySelector('[type="submit"]');
        const isEditing = editingBannerId !== null;
        const banner = {
            image: form.elements.image.value,
            altText: form.elements.altText.value
        };

        submitButton.disabled = true;
        document.getElementById('bannerStatus').textContent = '';
        try {
            const endpoint = isEditing
                ? '/api/admin/banners/' + encodeURIComponent(editingBannerId)
                : '/api/admin/banners';
            const response = await fetch(endpoint, {
                method: isEditing ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(banner)
            });
            if (response.status === 401) {
                window.location.assign('login.html');
                return;
            }
            if (response.status === 403) {
                window.location.assign('home.html');
                return;
            }
            await readApiJson(response, isEditing ? 'แก้ไข Banner ไม่สำเร็จ' : 'เพิ่ม Banner ไม่สำเร็จ');
            const status = document.getElementById('bannerStatus');
            if (isEditing) {
                cancelBannerEdit();
                status.textContent = 'แก้ไข Banner แล้ว';
            } else {
                form.reset();
                status.textContent = 'เพิ่ม Banner แล้ว';
            }
            await loadBanners();
        } catch (error) {
            console.error(error);
            document.getElementById('bannerStatus').textContent = error.message;
        } finally {
            submitButton.disabled = false;
        }
    });

    document.getElementById('cancelBannerEdit').addEventListener('click', cancelBannerEdit);

    document.getElementById('workForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const form = event.currentTarget;
        const submitButton = form.querySelector('[type="submit"]');
        const isEditing = editingWorkId !== null;
        const work = {
            title: form.elements.title.value,
            beforeImage: form.elements.beforeImage.value,
            afterImage: form.elements.afterImage.value
        };

        submitButton.disabled = true;
        document.getElementById('workStatus').textContent = '';
        try {
            const endpoint = isEditing
                ? '/api/admin/works/' + encodeURIComponent(editingWorkId)
                : '/api/admin/works';
            const response = await fetch(endpoint, {
                method: isEditing ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(work)
            });
            if (response.status === 401) {
                window.location.assign('login.html');
                return;
            }
            if (response.status === 403) {
                window.location.assign('home.html');
                return;
            }
            await readApiJson(response, isEditing ? 'แก้ไขผลงานไม่สำเร็จ' : 'เพิ่มผลงานไม่สำเร็จ');
            const status = document.getElementById('workStatus');
            if (isEditing) {
                cancelWorkEdit();
                status.textContent = 'แก้ไขผลงานแล้ว';
            } else {
                form.reset();
                status.textContent = 'เพิ่มผลงานแล้ว';
            }
            await loadWorks();
        } catch (error) {
            console.error(error);
            document.getElementById('workStatus').textContent = error.message;
        } finally {
            submitButton.disabled = false;
        }
    });

    document.getElementById('cancelWorkEdit').addEventListener('click', cancelWorkEdit);

    document.getElementById('adminReviewForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const form = event.currentTarget;
        const submitButton = form.querySelector('[type="submit"]');
        const isEditing = editingReviewId !== null;
        const review = {
            name: form.elements.name.value,
            rating: form.elements.rating.value,
            category: form.elements.category.value,
            review: form.elements.review.value,
            profileImage: form.elements.profileImage.value,
            photo: form.elements.photo.value
        };

        submitButton.disabled = true;
        document.getElementById('adminReviewStatus').textContent = '';
        try {
            const endpoint = isEditing
                ? '/api/admin/reviews/' + encodeURIComponent(editingReviewId)
                : '/api/admin/reviews';
            const response = await fetch(endpoint, {
                method: isEditing ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(review)
            });
            if (response.status === 401) {
                window.location.assign('login.html');
                return;
            }
            if (response.status === 403) {
                window.location.assign('home.html');
                return;
            }
            await readApiJson(response, isEditing ? 'แก้ไขรีวิวไม่สำเร็จ' : 'เพิ่มรีวิวไม่สำเร็จ');
            cancelAdminReviewEdit();
            document.getElementById('adminReviewStatus').textContent = isEditing
                ? 'แก้ไขรีวิวแล้ว'
                : 'เพิ่มรีวิวแล้ว';
            await Promise.all([loadAdminReviews(), refreshReviewOverview()]);
        } catch (error) {
            console.error(error);
            document.getElementById('adminReviewStatus').textContent = error.message;
        } finally {
            submitButton.disabled = false;
        }
    });

    document.getElementById('cancelReviewEdit').addEventListener('click', cancelAdminReviewEdit);

    loadDashboard().catch(function (error) {
        console.error(error);
        document.getElementById('registeredUsers').textContent = '-';
        document.getElementById('mechanicCount').textContent = '-';
        document.getElementById('totalReviewCount').textContent = '-';
        document.getElementById('reviewCategoryCounts').textContent = 'โหลดสรุปรีวิวไม่สำเร็จ';
        setServiceStatus('googleMapsStatus', 'unavailable', 'ตรวจสอบสถานะไม่สำเร็จ');
        setServiceStatus('otpStatus', 'unavailable', 'ตรวจสอบสถานะไม่สำเร็จ');
        document.getElementById('dashboardStatus').textContent = error.message;
    });
}());
