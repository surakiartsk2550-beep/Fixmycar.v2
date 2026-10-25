(function () {
    const portfolioGrid = document.querySelector('.portfolio-grid');
    const reviewList = document.querySelector('.review-list');
    const reviewCount = document.getElementById('reviewCount');
    const reviewForm = document.getElementById('reviewForm');
    const reviewStatus = document.createElement('p');
    const maxImageBytes = 2 * 1024 * 1024;
    const imagePreviews = [
        {
            input: document.getElementById('reviewProfileImage'),
            preview: document.getElementById('reviewProfilePreview'),
            previewUrl: ''
        },
        {
            input: document.getElementById('reviewPhoto'),
            preview: document.getElementById('reviewPhotoPreview'),
            previewUrl: ''
        }
    ];
    let totalReviewCount = null;
    let editingReviewId = null;

    reviewStatus.className = 'review-status';
    reviewStatus.setAttribute('role', 'status');

    function showReviewStatus(message) {
        reviewList.replaceChildren();
        reviewStatus.textContent = message;
        reviewList.append(reviewStatus);
    }

    function updateReviewCount(count) {
        totalReviewCount = count;
        reviewCount.textContent = '(' + count + ' รีวิว)';
    }

    function formatReviewDate(createdAt) {
        const utcDate = new Date(createdAt.replace(' ', 'T') + 'Z');
        if (Number.isNaN(utcDate.getTime())) {
            return { dateTime: '', label: createdAt };
        }

        const date = new Intl.DateTimeFormat('th-TH', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'Asia/Bangkok'
        }).format(utcDate);
        const time = new Intl.DateTimeFormat('th-TH', {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
            timeZone: 'Asia/Bangkok'
        }).format(utcDate);

        return {
            dateTime: utcDate.toISOString(),
            label: date + ' เวลา ' + time + ' น.'
        };
    }

    function createReviewCard(review) {
        const card = document.createElement('article');
        const top = document.createElement('div');
        const avatar = document.createElement('span');
        const avatarIcon = document.createElement('i');
        const reviewerInfo = document.createElement('div');
        const reviewerHeading = document.createElement('div');
        const name = document.createElement('strong');
        const stars = document.createElement('span');
        const createdAt = document.createElement('time');
        const text = document.createElement('p');

        card.className = 'review-card';
        card.dataset.reviewId = review.id;
        top.className = 'review-top';
        avatar.className = 'review-avatar';
        reviewerInfo.className = 'reviewer-info';
        reviewerHeading.className = 'reviewer-heading';
        name.textContent = review.name;
        stars.className = 'stars';
        stars.setAttribute('aria-label', review.rating + ' จาก 5 ดาว');
        stars.textContent = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
        createdAt.className = 'review-date';
        const formattedDate = formatReviewDate(review.createdAt);
        if (formattedDate.dateTime) createdAt.dateTime = formattedDate.dateTime;
        createdAt.textContent = formattedDate.label;
        text.textContent = review.review;

        if (review.profileImage) {
            const profileImage = document.createElement('img');
            profileImage.className = 'review-avatar-image';
            profileImage.src = review.profileImage;
            profileImage.alt = 'รูปโปรไฟล์ของ ' + review.name;
            avatar.append(profileImage);
        } else {
            avatar.setAttribute('aria-hidden', 'true');
            avatarIcon.className = 'fa-solid fa-user';
            avatar.append(avatarIcon);
        }
        reviewerHeading.append(name, stars);
        reviewerInfo.append(reviewerHeading, createdAt);
        top.append(avatar, reviewerInfo);
        card.append(top, text);

        if (review.category) {
            const categoryLabels = {
                repair: 'ช่างซ่อม',
                tirerepair: 'ช่างปะยาง',
                carwash: 'ล้างภายใน/ภายนอก',
                oilchange: 'ถ่ายน้ำมันเครื่อง',
                battery: 'เปลี่ยนแบต',
                carcheck: 'เช็คสภาพรถ'
            };
            const category = document.createElement('span');
            category.className = 'review-category';
            category.textContent = categoryLabels[review.category] || 'บริการอื่น';
            card.insertBefore(category, text);
        }

        if (review.photo) {
            const photo = document.createElement('img');
            photo.className = 'review-photo';
            photo.src = review.photo;
            photo.alt = 'ภาพผลงานจากรีวิว';
            card.append(photo);
        }

        if (review.isOwner) {
            const actions = document.createElement('div');
            const editButton = document.createElement('button');
            const deleteButton = document.createElement('button');
            actions.className = 'review-card-actions';
            editButton.className = 'review-owner-button';
            editButton.type = 'button';
            editButton.textContent = 'แก้ไข';
            editButton.addEventListener('click', function () {
                editReview(review);
            });
            deleteButton.className = 'review-owner-button review-owner-delete';
            deleteButton.type = 'button';
            deleteButton.textContent = 'ลบ';
            deleteButton.addEventListener('click', function () {
                deleteReview(review);
            });
            actions.append(editButton, deleteButton);
            card.append(actions);
        }

        return card;
    }

    function createWorkCard(work) {
        const card = document.createElement('article');
        const images = document.createElement('div');
        card.className = 'work-item';
        images.className = 'work-images';

        [
            { label: 'ก่อน', src: work.beforeImage },
            { label: 'หลัง', src: work.afterImage }
        ].forEach(function (workImage) {
            const figure = document.createElement('figure');
            const label = document.createElement('span');
            const image = document.createElement('img');
            figure.className = 'work-photo';
            label.textContent = workImage.label;
            image.src = workImage.src;
            image.alt = work.title + ' ' + workImage.label + 'ซ่อม';
            figure.append(label, image);
            images.append(figure);
        });

        const title = document.createElement('h3');
        title.textContent = work.title;
        card.append(images, title);
        return card;
    }

    async function loadWorks() {
        try {
            const response = await fetch('/api/works');
            if (!response.ok) {
                throw new Error('โหลดตัวอย่างผลงานไม่สำเร็จ กรุณาลองใหม่');
            }

            const data = await response.json();
            if (!Array.isArray(data.works)) {
                throw new Error('รูปแบบข้อมูลผลงานไม่ถูกต้อง');
            }
            if (data.works.length === 0) {
                portfolioGrid.replaceChildren();
                const emptyStatus = document.createElement('p');
                emptyStatus.className = 'work-status';
                emptyStatus.textContent = 'ยังไม่มีตัวอย่างผลงาน';
                portfolioGrid.append(emptyStatus);
                return;
            }

            portfolioGrid.replaceChildren(...data.works.map(createWorkCard));
        } catch (error) {
            console.error(error);
            portfolioGrid.replaceChildren();
            const errorStatus = document.createElement('p');
            errorStatus.className = 'work-status';
            errorStatus.textContent = error.message || 'โหลดตัวอย่างผลงานไม่สำเร็จ กรุณาลองใหม่';
            portfolioGrid.append(errorStatus);
        }
    }

    function readImageFile(file) {
        if (!file) return Promise.resolve('');
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
            return Promise.reject(new Error('เลือกรูปภาพ JPG, PNG หรือ WebP เท่านั้น'));
        }
        if (file.size > maxImageBytes) {
            return Promise.reject(new Error('รูปภาพแต่ละไฟล์ต้องมีขนาดไม่เกิน 2 MB'));
        }

        return new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.addEventListener('load', function () {
                if (typeof reader.result !== 'string') {
                    reject(new Error('อ่านรูปภาพไม่สำเร็จ กรุณาลองใหม่'));
                    return;
                }
                resolve(reader.result);
            });
            reader.addEventListener('error', function () {
                reject(new Error('อ่านรูปภาพไม่สำเร็จ กรุณาลองใหม่'));
            });
            reader.readAsDataURL(file);
        });
    }

    imagePreviews.forEach(function (item) {
        item.input.addEventListener('change', function () {
            if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
            item.previewUrl = '';
            const file = item.input.files[0];
            if (!file) {
                item.preview.removeAttribute('src');
                item.preview.classList.add('d-none');
                return;
            }

            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
                file.size > maxImageBytes) {
                item.input.value = '';
                item.preview.removeAttribute('src');
                item.preview.classList.add('d-none');
                alert(file.size > maxImageBytes
                    ? 'รูปภาพแต่ละไฟล์ต้องมีขนาดไม่เกิน 2 MB'
                    : 'เลือกรูปภาพ JPG, PNG หรือ WebP เท่านั้น');
                return;
            }

            item.previewUrl = URL.createObjectURL(file);
            item.preview.src = item.previewUrl;
            item.preview.classList.remove('d-none');
        });
    });

    async function loadReviews() {
        try {
            const response = await fetch('/api/reviews');
            if (!response.ok) {
                throw new Error('โหลดรีวิวไม่สำเร็จ กรุณาลองใหม่');
            }

            const data = await response.json();
            if (!Array.isArray(data.reviews)) {
                throw new Error('รูปแบบข้อมูลรีวิวไม่ถูกต้อง');
            }
            updateReviewCount(data.reviews.length);

            if (data.reviews.length === 0) {
                showReviewStatus('ยังไม่มีรีวิว');
                return;
            }

            reviewList.replaceChildren(...data.reviews.map(createReviewCard));
        } catch (error) {
            console.error(error);
            reviewCount.textContent = '(โหลดไม่สำเร็จ)';
            showReviewStatus(error.message || 'โหลดรีวิวไม่สำเร็จ กรุณาลองใหม่');
        }
    }

    document.getElementById('openReviewButton').addEventListener('click', function () {
        window.FixMyCarAuth.requireAuthenticated(function () {
            resetReviewForm();
            $('#reviewModal').modal('show');
        }, 'กรุณาเข้าสู่ระบบก่อนเขียนรีวิว');
    });

    function resetReviewForm() {
        editingReviewId = null;
        reviewForm.reset();
        document.getElementById('reviewModalTitle').textContent = 'เขียนรีวิว';
        reviewForm.querySelector('[type="submit"]').textContent = 'ส่งรีวิว';
        imagePreviews.forEach(function (item) {
            if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
            item.previewUrl = '';
            item.preview.removeAttribute('src');
            item.preview.classList.add('d-none');
        });
    }

    function editReview(review) {
        editingReviewId = review.id;
        document.getElementById('reviewName').value = review.name;
        document.getElementById('reviewRating').value = String(review.rating);
        document.getElementById('reviewCategory').value = review.category || '';
        document.getElementById('reviewText').value = review.review;
        [
            { item: imagePreviews[0], image: review.profileImage },
            { item: imagePreviews[1], image: review.photo }
        ].forEach(function (entry) {
            entry.item.input.value = '';
            if (entry.image) {
                entry.item.preview.src = entry.image;
                entry.item.preview.classList.remove('d-none');
            } else {
                entry.item.preview.removeAttribute('src');
                entry.item.preview.classList.add('d-none');
            }
        });
        document.getElementById('reviewModalTitle').textContent = 'แก้ไขรีวิว';
        reviewForm.querySelector('[type="submit"]').textContent = 'บันทึกการแก้ไข';
        $('#reviewModal').modal('show');
    }

    async function deleteReview(review) {
        if (!window.confirm('ยืนยันลบรีวิวของคุณหรือไม่?')) return;
        try {
            const response = await fetch('/api/reviews/' + encodeURIComponent(review.id), {
                method: 'DELETE'
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.message || 'ลบรีวิวไม่สำเร็จ กรุณาลองใหม่');
            }

            const card = Array.from(reviewList.children).find(function (item) {
                return item.dataset.reviewId === String(review.id);
            });
            if (card) card.remove();
            const remainingReviews = reviewList.querySelector('.review-card');
            if (!remainingReviews) showReviewStatus('ยังไม่มีรีวิว');
            updateReviewCount(Math.max(0, (totalReviewCount || 0) - 1));
        } catch (error) {
            console.error(error);
            alert(error.message || 'ลบรีวิวไม่สำเร็จ กรุณาลองใหม่');
        }
    }

    $('#reviewModal').on('hidden.bs.modal', resetReviewForm);

    reviewForm.addEventListener('submit', async function (event) {
        event.preventDefault();

        const submitButton = reviewForm.querySelector('[type="submit"]');
        submitButton.disabled = true;

        try {
            const isEditing = editingReviewId !== null;
            const [profileImage, photo] = await Promise.all([
                readImageFile(imagePreviews[0].input.files[0]),
                readImageFile(imagePreviews[1].input.files[0])
            ]);
            const response = await fetch(isEditing
                ? '/api/reviews/' + encodeURIComponent(editingReviewId)
                : '/api/reviews', {
                method: isEditing ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: document.getElementById('reviewName').value.trim(),
                    rating: Number(document.getElementById('reviewRating').value),
                    review: document.getElementById('reviewText').value.trim(),
                    category: document.getElementById('reviewCategory').value,
                    profileImage,
                    photo
                })
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.message || 'ส่งรีวิวไม่สำเร็จ กรุณาลองใหม่');
            }
            if (!data.review) {
                throw new Error('รูปแบบข้อมูลรีวิวไม่ถูกต้อง');
            }

            if (isEditing) {
                const existingCard = Array.from(reviewList.children).find(function (item) {
                    return item.dataset.reviewId === String(editingReviewId);
                });
                if (existingCard) existingCard.replaceWith(createReviewCard(data.review));
            } else {
                const emptyStatus = reviewList.querySelector('.review-status');
                if (emptyStatus) reviewList.replaceChildren();
                reviewList.prepend(createReviewCard(data.review));
                updateReviewCount((totalReviewCount === null ? 0 : totalReviewCount) + 1);
            }
            $('#reviewModal').modal('hide');
        } catch (error) {
            console.error(error);
            alert(error.message || 'ส่งรีวิวไม่สำเร็จ กรุณาลองใหม่');
        } finally {
            submitButton.disabled = false;
        }
    });

    loadWorks();
    loadReviews();
}());
