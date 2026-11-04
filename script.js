/* PULSAR RM 0.2 — MUSIC PLAYER */

const PulsarRM = {
    songs: [],
    currentIndex: -1,
    audio: new Audio(),

    elements: {},

    init() {
        this.elements = {
            importButton: document.getElementById("import-button"),
            fileInput: document.getElementById("music-files"),
            songList: document.getElementById("song-list"),
            songCount: document.getElementById("song-count"),
            player: document.getElementById("player"),
            playerTitle: document.getElementById("player-title"),
            playerArtist: document.getElementById("player-artist"),
            playButton: document.getElementById("play-button"),
            mainPlayButton: document.getElementById("main-play-button"),
            previousButton: document.getElementById("previous-button"),
            nextButton: document.getElementById("next-button"),
            progress: document.getElementById("progress"),
            currentTime: document.getElementById("current-time"),
            duration: document.getElementById("duration"),
            search: document.getElementById("search")
        };

        this.connectEvents();
        console.log("Pulsar RM iniciado correctamente 💜");
    },

    connectEvents() {
        this.elements.importButton.addEventListener("click", () => {
            this.elements.fileInput.click();
        });

        this.elements.fileInput.addEventListener("change", (event) => {
            this.importSongs(event.target.files);
        });

        this.elements.playButton.addEventListener("click", () => {
            this.togglePlayback();
        });

        this.elements.mainPlayButton.addEventListener("click", () => {
            this.togglePlayback();
        });

        this.elements.previousButton.addEventListener("click", () => {
            this.previousSong();
        });

        this.elements.nextButton.addEventListener("click", () => {
            this.nextSong();
        });

        this.audio.addEventListener("timeupdate", () => {
            this.updateProgress();
        });

        this.audio.addEventListener("loadedmetadata", () => {
            this.elements.duration.textContent = this.formatTime(
                this.audio.duration
            );
        });

        this.audio.addEventListener("ended", () => {
            this.nextSong();
        });

        this.elements.progress.addEventListener("input", () => {
            if (this.audio.duration) {
                this.audio.currentTime =
                    (this.elements.progress.value / 100) *
                    this.audio.duration;
            }
        });

        this.elements.search.addEventListener("input", (event) => {
            this.renderSongs(event.target.value);
        });
    },

    importSongs(files) {
        const selectedFiles = Array.from(files);

        selectedFiles.forEach(file => {
            if (!file.type.startsWith("audio/")) return;

            const song = {
                name: file.name.replace(/\.[^/.]+$/, ""),
                file: file,
                url: URL.createObjectURL(file)
            };

            this.songs.push(song);
        });

        this.updateSongCount();
        this.renderSongs();

        if (this.songs.length > 0) {
            this.elements.player.classList.remove("hidden");
        }

        this.elements.fileInput.value = "";
    },

    renderSongs(search = "") {
        const filteredSongs = this.songs
            .map((song, index) => ({ song, index }))
            .filter(item =>
                item.song.name.toLowerCase().includes(search.toLowerCase())
            );

        if (filteredSongs.length === 0) {
            this.elements.songList.innerHTML = `
                <div class="empty">
                    <div class="empty-icon">♫</div>
                    <h3>${search ? "No encontramos canciones" : "Tu música te espera"}</h3>
                    <p>${search ? "Prueba con otro nombre." : "Importa tus archivos de audio para comenzar."}</p>
                    ${search ? "" : '<button id="import-again" class="add-music">+ Importar música</button>'}
                </div>
            `;

            const button = document.getElementById("import-again");

            if (button) {
                button.addEventListener("click", () => {
                    this.elements.fileInput.click();
                });
            }

            return;
        }

        this.elements.songList.innerHTML = filteredSongs.map(item => `
            <div class="song-item">
                <div class="song-cover">♫</div>
                <div class="song-details">
                    <strong>${this.escapeHTML(item.song.name)}</strong>
                    <small>Archivo local</small>
                </div>
                <button data-play="${item.index}" aria-label="Reproducir">▶</button>
            </div>
        `).join("");

        this.elements.songList.querySelectorAll("[data-play]").forEach(button => {
            button.addEventListener("click", () => {
                this.playSong(Number(button.dataset.play));
            });
        });
    },

    playSong(index) {
        if (!this.songs[index]) return;

        this.currentIndex = index;

        this.audio.src = this.songs[index].url;
        this.audio.play().catch(error => {
            console.error("No se pudo reproducir:", error);
        });

        this.elements.playerTitle.textContent =
            this.songs[index].name;

        this.elements.playerArtist.textContent = "Archivo local";

        this.elements.player.classList.remove("hidden");

        this.updateButtons();
    },

    togglePlayback() {
        if (this.currentIndex === -1) {
            if (this.songs.length > 0) {
                this.playSong(0);
            }
            return;
        }

        if (this.audio.paused) {
            this.audio.play();
        } else {
            this.audio.pause();
        }

        this.updateButtons();
    },

    previousSong() {
        if (this.songs.length === 0) return;

        let index = this.currentIndex - 1;

        if (index < 0) {
            index = this.songs.length - 1;
        }

        this.playSong(index);
    },

    nextSong() {
        if (this.songs.length === 0) return;

        let index = this.currentIndex + 1;

        if (index >= this.songs.length) {
            index = 0;
        }

        this.playSong(index);
    },

    updateButtons() {
        const symbol = this.audio.paused ? "▶" : "Ⅱ";

        this.elements.playButton.textContent = symbol;
        this.elements.mainPlayButton.textContent = symbol;
    },

    updateProgress() {
        if (!this.audio.duration) return;

        const percentage =
            (this.audio.currentTime / this.audio.duration) * 100;

        this.elements.progress.value = percentage;

        this.elements.currentTime.textContent =
            this.formatTime(this.audio.currentTime);
    },

    updateSongCount() {
        this.elements.songCount.textContent =
            `${this.songs.length} canciones`;
    },

    formatTime(seconds) {
        if (!Number.isFinite(seconds)) return "0:00";

        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);

        return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
    },

    escapeHTML(text) {
        return text.replace(/[&<>"']/g, character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;"
        })[character]);
    }
};

document.addEventListener("DOMContentLoaded", () => {
    PulsarRM.init();
});
