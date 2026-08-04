//! MySQL database adapter for Pipa's framework-free database contracts.

#![warn(missing_docs)]

mod adapter;
mod mutation;
mod value;

pub use adapter::MySqlAdapter;
