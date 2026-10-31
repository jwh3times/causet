//! FastCDC as `docs/native-store/storage.md` §2 specifies it: 2/8/64 KiB with
//! normalization level 2, and the gear table derived from SHA-256. The
//! contract, not this code, defines the cut points; the tests hold this code to
//! its gear table and reference vectors.

/// No chunk is shorter, except a content object's last.
pub const MIN: usize = 2048;
/// The size normalization aims at: the strict mask applies below it, the loose one above.
pub const NORMAL: usize = 8192;
/// No chunk is longer.
pub const MAX: usize = 65536;
/// 15 bits set, within bits 16 to 47.
pub const MASK_S: u64 = 0x0000_d90f_0353_0000;
/// 11 bits set, a subset of `MASK_S`'s.
pub const MASK_L: u64 = 0x0000_d900_0353_0000;

/// Entry `i` is the first 8 bytes, big-endian, of SHA-256 of `cst fastcdc gear`
/// followed by the byte `i` (§2.2).
pub const GEAR: [u64; 256] = [
  0x1d89f18e12396175, 0xddc9fdc8a6e6cdae, 0x22b03f19f589663b, 0x5ddbc9107320f682,
  0x3fb0a3a659a6ad90, 0xe635904fef46d9ff, 0xa1f268bd8afce34a, 0xe03549cfdb727f85,
  0x724c54c51b6f26f5, 0x9277508393a5681d, 0x79032fa1a340501b, 0x4c43a0f150031c10,
  0x750aad9805dd52a8, 0xcd4618cde3bd3f94, 0x1202d429a9c391ee, 0x2046f5b6b3a827fc,
  0x3a0b9e31d06debcf, 0x60508a62a0e1bf29, 0x3c42e3ab309f03b3, 0x552ee8ef50c9e3cf,
  0x0a950b1c207f8669, 0xcc74954308fc4967, 0x3d788787575c3816, 0xbab26bd03d7bfda6,
  0x7875c894911cda1f, 0x0fe2baa344f21ff0, 0x84db2f60f2350c67, 0x527976eaeb6c0670,
  0x496d4f13bc99a5ec, 0x9e037562aa9961f6, 0x77a361725f85a66c, 0x9992269f6a32121f,
  0x209dc2f6ba48f8fd, 0xd6a9fdc431a67f0e, 0xf6aefcfaccbf986b, 0x1c5d160e3ff7802b,
  0xb81404c5680eed51, 0x620243dc77860c3e, 0x67941490feafbc92, 0x75a60631ddefc5ba,
  0x33ecc077808a16ef, 0x36b9302ea4574afe, 0x6c7770bcbf082b6f, 0x6d3a942f85829548,
  0x9ed7dc78125b10de, 0x17a40669e6b1dc7a, 0x3e6ced1c3183cf50, 0x301c79db311c7c3a,
  0x22daa127e3be295f, 0xa53f3cc69dadb646, 0x54320d12c4fc7a2a, 0x5ddf1415ad059014,
  0x23ae41fd258ab367, 0xb69d9bd3f0ea3d6a, 0x1b03e9e8f2b0679b, 0xe87002bc230c68a3,
  0x983ea419862dbb37, 0xec1926d91e76134a, 0x7f01a57c939d7333, 0x52498e9c436a7119,
  0x6accc68615194a2d, 0x23f33d8af18fb786, 0x286dd4517875e2cf, 0x9e8e549cea587a91,
  0x2226a20c7be46215, 0xf54e096d2ba68760, 0xb8e805626b5d8ebc, 0xdbaac61baa661026,
  0xd2e57588f32e0d1e, 0x823ebbb9b1a4469e, 0x8a513197bf39cf0a, 0x9f88e26e5359b2fc,
  0x3894214aca2ad446, 0xabdee53efa329563, 0xfc2e0ead7104c5c6, 0x333ad23e59d61310,
  0x455c5f256125f1b4, 0xd147ead522a1e732, 0x50bc1bba3c2dc0b1, 0x5a079ede9eac5bb3,
  0x189b88eaf2dac6ba, 0x40a3f8b990679a3e, 0x06d91d01898a5a5a, 0x8ed48a40aafaab66,
  0x12292f748d144743, 0x8b332dcc18036c5c, 0xab0976a88664994e, 0x9d9dc86cdc7a43d4,
  0xaa349f629c735a4e, 0xbdf8292b08599440, 0xeb4f9f71299ffb8d, 0xe205873c38ba6398,
  0xe0fe47b47f43b864, 0xed8ba500ba04892e, 0xa9a98aedf5ace88c, 0xe0b7b032e69b6f7f,
  0x869b30f39435344f, 0x6efba7916e28e798, 0x322eaa793e30855b, 0x01d5832ad598620b,
  0x7335efc7e1f5eb89, 0x2b8dfc9b6f44bad2, 0x8000c57ccb68835f, 0x7c8605c5ec05c3ae,
  0x932e25cea0fef569, 0x6903df3fa3b6acaf, 0xf2102940dca5e422, 0xa277625d215ad6bd,
  0xfba26790a1c5c8f6, 0xc03545def3842f4a, 0x68446d49f829dd1a, 0xf521cccbc7bc39d9,
  0xe842a73db160e699, 0xc3caab0bff36c673, 0xead756c34f39d2d7, 0x09ab9a91bf26de28,
  0x024a9f5c927dedf8, 0xd4986cd2a62350d3, 0x508e9654044ed10a, 0x6aca3ee43696c404,
  0x4326ff6b1d76d8a9, 0xfddc2a06b11f4d89, 0x4d4ac68a6f08d428, 0x5890803fef50493f,
  0x2f0767ea19cfda3b, 0x9a692be66397aea2, 0xad078f1e869f05bb, 0xda33e8d77e9eb07b,
  0x4d059ca47316813e, 0x10c6445cc72cb6cc, 0x77c7c615a81b37ec, 0xdfa782c286bf2677,
  0xfa45cdf0ca0f68e8, 0x8121ceeefd78cfbb, 0x80fa771e821f58ea, 0xef96e8d7a54cb775,
  0x9b67dcbfc5acfda3, 0xb3a1609441ca3f4c, 0x974bcf2b0836fe14, 0x3bbd1b5f7368aa20,
  0x521c7f3466ef57fa, 0xfbd8735ec5837145, 0xfe4eafe248d9aa83, 0x0848254c836acebe,
  0x4228c077e1765ee5, 0x01dcca310ceebcec, 0xf8230a185927af8d, 0xb3e5948da5758346,
  0x1a25e8c60c1c84d8, 0x5a9403255399f142, 0xe9687d53ce29ccb4, 0x66ec9cb64d6df6f2,
  0x4c804720f6b44f18, 0x7718e90b067adb8f, 0x130ca4cc7fe73cb7, 0xe7ffb21d945e1db4,
  0xe54a22b5d9079a29, 0xe5e974ca54c7c08d, 0x4073d53d14685bd7, 0xde3c9179a09db448,
  0x4614b7f72ceea410, 0x6eb8b93a52bf2dfc, 0x3edb99f4527623e4, 0x9b969fcb6c244ff1,
  0xa9e8add845fa84a1, 0xa6e35b6d4296b819, 0xfeb2e347d96fcebe, 0x45af9eb48ba190ab,
  0x8f91067a031fb396, 0xd9ab83f3fb46d3b3, 0xc0e241d352fb8a80, 0x9a61f6f4a0c4a45c,
  0xbda43a64be3b68c0, 0x83ea09039df6fabd, 0xe444daf5cc6923e6, 0x8a6dbc8f55163c7b,
  0x31ab9deb6e4fa268, 0xe439f6a8acbf1c1b, 0xb0e60de84f58b4fd, 0x5cc1af0cfd04623e,
  0xbf07d3f073a28db6, 0x347d7e64f7761d73, 0x506846b312bddafb, 0x999931dfc96ba10e,
  0x328ef718391371f2, 0x1e90a0b0104a911c, 0x20e0d733deb5eef4, 0x5fc80ae9fb9e5545,
  0xec1a11879c94b99b, 0x057d9293950ffeec, 0x27935a20370929ae, 0xaf2e520470d31bd0,
  0xdd0af96d6d3c24f5, 0x2bb1f3f898f26910, 0xe7ab67378a47785e, 0x7cd4d1222fd86091,
  0x76ca09a6ad5b7d50, 0x521a2e2e50a684e0, 0xd6507347d15eec6e, 0xfb50beb537ee6ec9,
  0x7d65c56cc675fab3, 0x492c97227e9a9ee1, 0x48e5566c0f1be91c, 0x672ba33b9a23e527,
  0x2fa567de2d6c23f0, 0xff4c877cd794d131, 0x4f913c532e1b7a18, 0x5ee5c00f8fc375d3,
  0xae3830e2ce2300b9, 0xf63c986b4054cfa2, 0x0c80564e27209df1, 0x5ff92575b2d63ae6,
  0x59bd1053f1b1c61c, 0x10a46fe719d6fb85, 0x68a804534f9c71e5, 0x133107bd47b56acc,
  0x746d50d9cc307061, 0x703f25861fe8b106, 0xd8bf4d6ba5bb69ac, 0x3b9a5b7e2d3be137,
  0xd2dfc757b0221650, 0x6db9204dd0d8c587, 0xdb341b4ef7632c6f, 0x2d8621c8b2a73e02,
  0x21aabbb5b362b266, 0xc6245d05f21aeb64, 0xe155346c3a52cf58, 0xd78359fa449258ce,
  0x7908bf9d8ec9a8c9, 0x2a702ff0fb674a78, 0x0325c376684ac194, 0x3dc9efb32d31edd8,
  0xf117607b21f2bbe2, 0x33e749a9b23ad8d7, 0x721cc1db2414e085, 0xa411ccd31bf22e79,
  0x9235b2ef1dcb3551, 0x05aa6af7b57553b3, 0x143b074c8c3c0950, 0xc9069885adcc710e,
  0x7ecf1e7663ebfe1e, 0xe00463ddf3ba29ee, 0xdb87b49d5b8e7a6c, 0xa2326e69269ad445,
  0x4e73773c86f0d93d, 0x8783e5d38fbaa473, 0xbc098dc0273a2116, 0x5b5a63c46ff84689,
  0xf4284c3963738fb3, 0x976771be461eded2, 0xca6cd4b8593429e5, 0x2c8cdf6196ae19ce,
  0x19ccf1dfc9647cd5, 0xc7641930e4e87947, 0xbdfb9eccdd12099b, 0x413d4c27ec8bff09,
];

/// The length of the chunk that starts at the front of `data` (§2.3). It is
/// `data.len()` when `data` is no longer than `MIN`, and 0 only for empty data.
pub fn cut(data: &[u8]) -> usize {
  let n = data.len();
  if n <= MIN {
    return n;
  }
  let limit = n.min(MAX);
  let normal = limit.min(NORMAL);
  let mut fp: u64 = 0;
  let mut i = MIN;
  while i < normal {
    fp = (fp << 1).wrapping_add(GEAR[data[i] as usize]);
    i += 1;
    if fp & MASK_S == 0 {
      return i;
    }
  }
  while i < limit {
    fp = (fp << 1).wrapping_add(GEAR[data[i] as usize]);
    i += 1;
    if fp & MASK_L == 0 {
      return i;
    }
  }
  limit
}

/// A content object's chunks, cut from its first byte. Empty content has none.
pub fn chunks(data: &[u8]) -> Chunks<'_> {
  Chunks { rest: data }
}

pub struct Chunks<'a> {
  rest: &'a [u8],
}

impl<'a> Iterator for Chunks<'a> {
  type Item = &'a [u8];

  fn next(&mut self) -> Option<&'a [u8]> {
    if self.rest.is_empty() {
      return None;
    }
    let (chunk, rest) = self.rest.split_at(cut(self.rest));
    self.rest = rest;
    Some(chunk)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn lengths(data: &[u8]) -> Vec<usize> {
    chunks(data).map(<[u8]>::len).collect()
  }

  #[test]
  fn the_masks_are_as_the_contract_counts_them() {
    assert_eq!(MASK_S.count_ones(), 15);
    assert_eq!(MASK_L.count_ones(), 11);
    assert_eq!(MASK_L & !MASK_S, 0);
    let window = ((1u64 << 48) - 1) & !((1u64 << 16) - 1);
    assert_eq!(MASK_S & !window, 0);
  }

  #[test]
  fn input_that_never_meets_a_mask_is_cut_every_max_bytes() {
    assert_eq!(lengths(&[0; 200_000]), [MAX, MAX, MAX, 3392]);
    assert_eq!(lengths(&[0; MAX + 1]), [MAX, 1]);
  }

  #[test]
  fn short_input_is_one_chunk_and_empty_input_none() {
    assert!(lengths(&[]).is_empty());
    assert_eq!(lengths(&[7]), [1]);
    assert_eq!(lengths(&[0; MIN]), [MIN]);
    assert_eq!(lengths(&[0; MIN + 1]), [MIN + 1]);
  }

  #[test]
  fn the_chunks_cover_the_input_in_order() {
    let data: Vec<u8> = (0..300_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8).collect();
    let joined: Vec<u8> = chunks(&data).flatten().copied().collect();
    assert_eq!(joined, data);
    let sizes = lengths(&data);
    assert!(sizes[..sizes.len() - 1].iter().all(|&n| n > MIN && n <= MAX));
  }
}
