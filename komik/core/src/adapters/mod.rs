//! Adapter per sumber. Setiap adapter = satu file; lane implementasi hanya
//! menyentuh file-nya sendiri.
pub mod komiku;
pub mod mangaku;
pub mod kiryuu;
pub mod shinigami;

use crate::model::SourceId;
use crate::source::Source;
use std::sync::Arc;

/// Registry semua sumber. Tiap adapter ambil reqwest::Client yang sama
/// (pola komiku-server: satu static Client). Lane adapter hanya mengisi file
/// adapters/<nama>.rs — call site di sini tetap.
pub fn all_sources(client: reqwest::Client) -> Vec<Arc<dyn Source>> {
    vec![
        Arc::new(super::adapters::komiku::KomikuSource::new(client.clone())) as Arc<dyn Source>,
        Arc::new(super::adapters::mangaku::MangakuSource::new(client.clone())) as Arc<dyn Source>,
        Arc::new(super::adapters::shinigami::ShinigamiSource::new(client.clone())) as Arc<dyn Source>,
        Arc::new(super::adapters::kiryuu::KiryuuSource::new(client)) as Arc<dyn Source>,
    ]
}

pub fn source_ids() -> Vec<SourceId> {
    SOURCE_PRIORITY.iter().map(|s| SourceId::from(*s)).collect()
}

use crate::model::SOURCE_PRIORITY;
